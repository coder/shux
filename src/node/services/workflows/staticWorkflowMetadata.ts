export const STATIC_METADATA_ERROR =
  "Workflow meta must be a static object literal using JSON-compatible values and mux.schema helpers or aliases";
const SCHEMA_ROOT_PREFIX = "mux.schema.";
const OPTIONAL_SCHEMA_MARKER = Symbol("mux.schema.optional");
const SUPPORTED_SCHEMA_CALLS = new Set([
  "array",
  "boolean",
  "enum",
  "integer",
  "nullable",
  "number",
  "object",
  "optional",
  "string",
  "union",
]);
const SUPPORTED_SCHEMA_OPTION_KEYS = new Set([
  "additionalProperties",
  // Legacy freeform parser hints are ignored by structured invocation, but still
  // accepted so existing workflow schemas do not lose metadata/forms.
  "aliases",
  "default",
  "enum",
  "maximum",
  "minimum",
  "negatedAliases",
  "positional",
  "required",
]);

interface MetadataLiteralRange {
  declarationStart: number;
  declarationEnd: number;
  start: number;
  end: number;
  literal: string;
}

export function parseStaticWorkflowMetadataLiteral(source: string): unknown {
  const metadata = findRequiredStaticMetadataLiteral(source);
  return new StaticMetadataLiteralParser(
    metadata.literal,
    findStaticMuxSchemaAliases(source, metadata.declarationStart)
  ).parseValue();
}

function findRequiredStaticMetadataLiteral(source: string): MetadataLiteralRange {
  const metadata = findStaticMetadataLiteral(source);
  if (metadata == null) throw new Error(STATIC_METADATA_ERROR);
  return metadata;
}

// A top-level `export const meta` may follow a line start, a `;`, or a
// self-terminating block (`if (x) {} export const meta = ...`); the depth check
// in isTopLevelStaticMatch still rejects declarations nested inside braces.
const META_DECLARATION_PATTERN = /(^|[;\n}])\s*export\s+(?:const|let|var)\s+meta\s*=/mu;

/**
 * Locate `export const meta =` at module top level. The depth check runs at the
 * declaration start — AFTER the separator — so a preceding `}` that closes a
 * top-level block is consumed rather than leaving the scan one level deep.
 */
function matchTopLevelMetaDeclaration(
  maskedSource: string
): { declarationStart: number; end: number } | null {
  const match = META_DECLARATION_PATTERN.exec(maskedSource);
  if (match == null) return null;
  const declarationStart = match.index + (match[1]?.length ?? 0);
  if (!isTopLevelStaticMatch(maskedSource, declarationStart)) return null;
  return { declarationStart, end: match.index + match[0].length };
}

/**
 * Whether the top-level `export const meta = { ... }` literal MAY declare `key`
 * among its own (depth-0) properties, tolerating non-static values such as
 * `{ phases }` or `{ phases: buildPhases() }` that the strict parser rejects.
 * Conservative by construction: a top-level spread (`...x`) or a dynamic computed
 * key (`[k]`) could supply the key at runtime, so both count as "may". False when
 * no object literal can be located at all (`export const meta = x`). Lets run
 * creation tell "unreadable meta that may declare phases" apart from legacy
 * unreadable meta that must keep being ignored.
 */
export function staticMetadataLiteralMayDeclareKey(source: string, key: string): boolean {
  // Structure (depth, comments, string/template bodies) comes from the masked
  // text, which preserves indexes; key tokens are read from the original source.
  // The strict locator is NOT used for the object extent: it throws on template
  // interpolation, which would hide a `phases` key sitting next to one.
  const masked = maskStaticJavaScriptSource(source);
  const match = matchTopLevelMetaDeclaration(masked);
  if (match == null) return false;
  // Transparent parentheses around the literal (`meta = ({ ... })`) change nothing.
  let start = skipStaticWhitespace(masked, match.end);
  while (masked[start] === "(") {
    start = skipStaticWhitespace(masked, start + 1);
  }
  if (masked[start] !== "{") return false;
  const end = findMaskedObjectEnd(masked, start);
  if (end === -1) return false;
  // An identifier escape (`pha\u0073es:`) defeats textual key reading; the
  // masked text has no string/comment/regex bodies, so any remaining backslash
  // is one, and the literal may declare anything.
  if (masked.slice(start, end).includes("\\")) return true;
  let depth = 0;
  let expectKey = true;
  for (let index = start + 1; index < end; index += 1) {
    const char = masked[index];
    if (depth === 0 && expectKey && char === "[") {
      // Computed key. A static string literal names the key outright
      // (`["phases"]`, escapes decoded by the strict parser); anything dynamic
      // (`[k]`) could evaluate to it, so it counts as "may declare".
      const close = masked.indexOf("]", index);
      if (close === -1) return true;
      expectKey = false;
      try {
        const decoded = new StaticMetadataLiteralParser(
          source.slice(index + 1, close),
          new Set()
        ).parseValue();
        if (decoded === key) return true;
      } catch {
        return true;
      }
      index = close;
      continue;
    }
    if (depth === 0 && expectKey && masked.startsWith("...", index)) {
      // Top-level spread: the spread object may carry the key.
      return true;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]" || char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (char === ",") {
      expectKey = true;
      continue;
    }
    if (!expectKey || /\s/u.test(char ?? "")) continue;
    expectKey = false;
    try {
      // Method/accessor syntax the strict parser never accepts still has a
      // definite key: `helper() {}` → helper, `get phases() {}` → phases,
      // `*phases() {}` → phases. Read past a generator star and past a
      // get/set/async modifier that is followed by another key token.
      let keyStart = index;
      if (masked[keyStart] === "*") keyStart = skipStaticWhitespace(masked, keyStart + 1);
      let token = readStaticObjectKey(source, keyStart);
      const next = skipStaticWhitespace(masked, token.end);
      const isModifier =
        (token.value === "get" || token.value === "set" || token.value === "async") &&
        next < end &&
        ![":", ",", "}", "("].includes(masked[next] ?? "");
      if (isModifier) {
        const realKeyStart = masked[next] === "*" ? skipStaticWhitespace(masked, next + 1) : next;
        token = readStaticObjectKey(source, realKeyStart);
      }
      if (token.value === key) return true;
      // Parameters and bodies that follow are skipped by the depth tracking.
      index = token.end - 1;
    } catch {
      // Unreadable key syntax: may declare anything.
      return true;
    }
  }
  return false;
}

/** Reads an identifier or quoted object key at `start` (used to scan the meta literal's top-level keys). */
function readStaticObjectKey(source: string, start: number): { value: string; end: number } {
  const index = skipStaticWhitespace(source, start);
  const char = source[index];
  if (char === '"' || char === "'") {
    return readStaticStringLiteral(source, index, char);
  }
  const match = /^[A-Za-z_$][A-Za-z0-9_$-]*/u.exec(source.slice(index));
  if (match == null) throw new Error(STATIC_METADATA_ERROR);
  return { value: match[0], end: index + match[0].length };
}

function readStaticStringLiteral(
  source: string,
  start: number,
  quote: string
): { value: string; end: number } {
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const char = source[index];
    if (char === quote) return { value, end: index + 1 };
    if (isStaticTemplateInterpolationStart(source, index, quote)) {
      throw new Error(STATIC_METADATA_ERROR);
    }
    if (char === "\\") {
      const escape = source[index + 1];
      if (escape == null) throw new Error(STATIC_METADATA_ERROR);
      value += "\\" + escape;
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }
  throw new Error(STATIC_METADATA_ERROR);
}

/**
 * Whether the `meta` export is declared with `const` and the identifier `meta` is
 * mentioned nowhere else in the (comment/string-masked) source. `export let meta`
 * or any later `meta = …` / `meta.phases.push(…)` / `helper(meta)` could change
 * the exported phases after the static read, so callers reject those.
 */
export function isStaticMetadataBindingImmutable(source: string): boolean {
  const masked = maskStaticJavaScriptSource(source);
  const match = matchTopLevelMetaDeclaration(masked);
  if (match == null) return false;
  const declaration = masked.slice(match.declarationStart, match.end);
  if (!/\bconst\b/u.test(declaration)) return false;
  // Identifier escapes (`m\u0065ta = …`) resolve to the same binding but defeat a
  // textual scan; masked code keeps no string/comment/regex bodies, so any
  // backslash left is one — treat the binding as not provably immutable.
  if (masked.includes("\\")) return false;
  // Direct eval / the Function constructor can name the binding from inside a
  // string the masker blanked; neither is provably absent from the mentions below.
  if (/(?<![\w$.])(eval|Function)(?![\w$])/u.test(masked)) return false;
  const mentions = masked.matchAll(/(?<![\w$.])meta(?![\w$])/gu);
  for (const mention of mentions) {
    const inDeclaration = mention.index >= match.declarationStart && mention.index < match.end;
    if (!inDeclaration) return false;
  }
  return true;
}

/** Index just past the `}` matching the `{` at `start` in masked source, or -1. */
function findMaskedObjectEnd(masked: string, start: number): number {
  let depth = 0;
  for (let index = start; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function findStaticMetadataLiteral(source: string): MetadataLiteralRange | null {
  const maskedSource = maskStaticJavaScriptSource(source);
  const match = matchTopLevelMetaDeclaration(maskedSource);
  if (match != null) {
    const { declarationStart } = match;
    const start = skipStaticWhitespace(source, match.end);
    const end = readObjectLiteralEnd(source, start);
    let declarationEnd = skipStaticHorizontalWhitespace(source, end);
    if (source[declarationEnd] === ";") {
      declarationEnd = skipStaticTrailingNewline(source, declarationEnd + 1);
    }
    return {
      declarationStart,
      declarationEnd,
      start,
      end,
      literal: source.slice(start, end),
    };
  }
  return null;
}

function findStaticMuxSchemaAliases(source: string, beforeIndex: number): Set<string> {
  const aliases = new Set<string>();
  const maskedSource = maskStaticJavaScriptSource(source.slice(0, beforeIndex));
  const pattern =
    /(^|[;\n])\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*mux\.schema\s*(?:[;\n]|$)/gmu;
  for (const match of maskedSource.matchAll(pattern)) {
    if (!isTopLevelStaticMatch(maskedSource, match.index)) continue;
    const alias = match[2];
    if (alias == null || alias === "mux") continue;
    aliases.add(alias);
  }
  return aliases;
}

function skipStaticHorizontalWhitespace(source: string, start: number): number {
  let index = start;
  while (source[index] === " " || source[index] === "\t") {
    index += 1;
  }
  return index;
}

function skipStaticTrailingNewline(source: string, start: number): number {
  const index = skipStaticHorizontalWhitespace(source, start);
  if (source[index] === "\r" && source[index + 1] === "\n") return index + 2;
  if (source[index] === "\n") return index + 1;
  return index;
}

function readObjectLiteralEnd(source: string, start: number): number {
  if (source[start] !== "{") throw new Error(STATIC_METADATA_ERROR);
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipQuotedString(source, index, char);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index + 2);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index + 2);
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  throw new Error(STATIC_METADATA_ERROR);
}

function skipStaticWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (/\s/u.test(char ?? "")) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index + 2);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index + 2);
      continue;
    }
    break;
  }
  return index;
}

function skipQuotedString(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (isStaticTemplateInterpolationStart(source, index, quote)) {
      throw new Error(STATIC_METADATA_ERROR);
    }
    if (char === quote) return index + 1;
    index += 1;
  }
  throw new Error(STATIC_METADATA_ERROR);
}

function isStaticTemplateInterpolationStart(source: string, index: number, quote: string): boolean {
  return quote === "`" && source[index] === "$" && source[index + 1] === "{";
}

function skipLineComment(source: string, start: number): number {
  const end = source.indexOf("\n", start);
  return end === -1 ? source.length : end + 1;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start);
  if (end === -1) throw new Error(STATIC_METADATA_ERROR);
  return end + 2;
}

class StaticMetadataLiteralParser {
  private index = 0;
  private readonly schemaCallPrefixes: string[];

  constructor(
    private readonly source: string,
    schemaAliases: Set<string>
  ) {
    this.schemaCallPrefixes = [
      SCHEMA_ROOT_PREFIX,
      ...Array.from(schemaAliases, (alias) => `${alias}.`),
    ].sort((left, right) => right.length - left.length);
  }

  parseValue(): unknown {
    this.skipWhitespaceAndComments();
    const value = this.readValue();
    this.skipWhitespaceAndComments();
    if (this.index !== this.source.length) throw new Error(STATIC_METADATA_ERROR);
    return value;
  }

  private readValue(): unknown {
    this.skipWhitespaceAndComments();
    const char = this.source[this.index];
    if (char === "{") return this.readObject();
    if (char === "[") return this.readArray();
    if (char === '"' || char === "'" || char === "`") return this.readString(char);
    const schemaCallPrefix = this.matchSchemaCallPrefix();
    if (schemaCallPrefix != null) return this.readSchemaCall(schemaCallPrefix);
    if (this.source.startsWith("true", this.index)) {
      this.index += "true".length;
      return true;
    }
    if (this.source.startsWith("false", this.index)) {
      this.index += "false".length;
      return false;
    }
    if (this.source.startsWith("null", this.index)) {
      this.index += "null".length;
      return null;
    }
    return this.readNumber();
  }

  private readObject(): Record<string, unknown> {
    this.expect("{");
    const result: Record<string, unknown> = {};
    this.skipWhitespaceAndComments();
    while (!this.consume("}")) {
      const key = this.readObjectKey();
      this.skipWhitespaceAndComments();
      this.expect(":");
      result[key] = this.readValue();
      this.skipWhitespaceAndComments();
      if (this.consume("}")) break;
      this.expect(",");
      this.skipWhitespaceAndComments();
    }
    return result;
  }

  private readArray(): unknown[] {
    this.expect("[");
    const result: unknown[] = [];
    this.skipWhitespaceAndComments();
    while (!this.consume("]")) {
      result.push(this.readValue());
      this.skipWhitespaceAndComments();
      if (this.consume("]")) break;
      this.expect(",");
      this.skipWhitespaceAndComments();
    }
    return result;
  }

  private readObjectKey(): string {
    this.skipWhitespaceAndComments();
    const char = this.source[this.index];
    if (char === '"' || char === "'" || char === "`") return this.readString(char);
    const match = /^[A-Za-z_$][A-Za-z0-9_$-]*/u.exec(this.source.slice(this.index));
    if (match == null) throw new Error(STATIC_METADATA_ERROR);
    this.index += match[0].length;
    return match[0];
  }

  private readString(quote: string): string {
    this.expect(quote);
    let value = "";
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      this.index += 1;
      if (char === quote) return value;
      if (isStaticTemplateInterpolationStart(this.source, this.index - 1, quote)) {
        throw new Error(STATIC_METADATA_ERROR);
      }
      if (char === "\\") value += this.readEscapeSequence();
      else value += char;
    }
    throw new Error(STATIC_METADATA_ERROR);
  }

  private readEscapeSequence(): string {
    const char = this.source[this.index];
    this.index += 1;
    // `/` is included because JSON permits an escaped solidus (`"https:\\/\\/…"`);
    // JSON.stringify output and hand-written URLs both use it.
    switch (char) {
      case '"':
      case "'":
      case "\\":
      case "`":
      case "/":
        return char;
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.source.slice(this.index, this.index + 4);
        if (!/^[0-9A-Fa-f]{4}$/u.test(hex)) throw new Error(STATIC_METADATA_ERROR);
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        throw new Error(STATIC_METADATA_ERROR);
    }
  }

  private readNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.source.slice(this.index)
    );
    if (match == null) throw new Error(STATIC_METADATA_ERROR);
    this.index += match[0].length;
    return Number(match[0]);
  }

  private matchSchemaCallPrefix(): string | null {
    return (
      this.schemaCallPrefixes.find((prefix) => this.source.startsWith(prefix, this.index)) ?? null
    );
  }

  private readSchemaCall(prefix: string): Record<string, unknown> {
    this.index += prefix.length;
    const nameMatch = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(this.source.slice(this.index));
    if (nameMatch == null || !SUPPORTED_SCHEMA_CALLS.has(nameMatch[0])) {
      throw new Error(STATIC_METADATA_ERROR);
    }
    const name = nameMatch[0];
    this.index += name.length;
    this.skipWhitespaceAndComments();
    this.expect("(");
    const args: unknown[] = [];
    this.skipWhitespaceAndComments();
    while (!this.consume(")")) {
      args.push(this.readValue());
      this.skipWhitespaceAndComments();
      if (this.consume(")")) break;
      this.expect(",");
      this.skipWhitespaceAndComments();
    }
    return schemaFromCall(name, args);
  }

  private skipWhitespaceAndComments(): void {
    this.index = skipStaticWhitespace(this.source, this.index);
  }

  private consume(expected: string): boolean {
    if (this.source[this.index] !== expected) return false;
    this.index += 1;
    return true;
  }

  private expect(expected: string): void {
    if (!this.consume(expected)) throw new Error(STATIC_METADATA_ERROR);
  }
}

function schemaFromCall(name: string, args: unknown[]): Record<string, unknown> {
  switch (name) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return schemaWithOptions({ type: name }, args[0]);
    case "array":
      return schemaWithOptions(
        { type: "array", items: requiredSchema(args[0], "array items") },
        args[1]
      );
    case "enum":
      return schemaWithOptions(
        { type: "string", enum: requiredArray(args[0], "enum values") },
        args[1]
      );
    case "union":
      return unionSchema(requiredArray(args[0], "union schemas"));
    case "object":
      return objectSchema(args[0], args[1]);
    case "optional":
      return optionalSchema(requiredSchema(args[0], "optional schema"));
    case "nullable":
      return nullableSchema(requiredSchema(args[0], "nullable schema"));
    default:
      throw new Error(STATIC_METADATA_ERROR);
  }
}

function schemaWithOptions(
  schema: Record<string, unknown>,
  rawOptions: unknown
): Record<string, unknown> {
  const options = rawOptions == null ? {} : requiredPlainObject(rawOptions, "schema options");
  for (const key of Object.keys(options)) {
    if (!SUPPORTED_SCHEMA_OPTION_KEYS.has(key)) throw new Error(STATIC_METADATA_ERROR);
  }
  return { ...schema, ...options };
}

function objectSchema(rawProperties: unknown, rawOptions: unknown): Record<string, unknown> {
  const properties = requiredPlainObject(rawProperties, "object properties");
  const options = rawOptions == null ? {} : requiredPlainObject(rawOptions, "object options");
  const cleanProperties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const propertySchema = requiredSchema(value, `object property ${key}`);
    cleanProperties[key] = stripOptionalSchema(propertySchema);
    if (!isOptionalSchema(propertySchema)) required.push(key);
  }
  const requiredOption = options.required;
  const optionRequired = Array.isArray(requiredOption)
    ? requiredOption.filter(
        (key): key is string => typeof key === "string" && key in cleanProperties
      )
    : requiredOption === false
      ? []
      : required;
  const schema: Record<string, unknown> = {
    type: "object",
    required: optionRequired,
    properties: cleanProperties,
  };
  if (Object.prototype.hasOwnProperty.call(options, "additionalProperties")) {
    schema.additionalProperties = options.additionalProperties;
  }
  return schema;
}

function unionSchema(schemas: unknown[]): Record<string, unknown> {
  const types: string[] = [];
  for (const rawSchema of schemas) {
    const schema = requiredSchema(rawSchema, "union member");
    const type = schema.type;
    if (typeof type === "string") {
      if (!types.includes(type)) types.push(type);
    } else if (Array.isArray(type)) {
      for (const candidate of type) {
        if (typeof candidate === "string" && !types.includes(candidate)) types.push(candidate);
      }
    } else {
      throw new Error("union member must have a type");
    }
  }
  return { type: types };
}

function optionalSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...schema };
  Object.defineProperty(clone, OPTIONAL_SCHEMA_MARKER, { value: true });
  return clone;
}

function isOptionalSchema(schema: Record<string, unknown>): boolean {
  return Boolean((schema as { [OPTIONAL_SCHEMA_MARKER]?: boolean })[OPTIONAL_SCHEMA_MARKER]);
}

function stripOptionalSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!isOptionalSchema(schema)) return schema;
  return { ...schema };
}

function nullableSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...schema };
  const type = clone.type;
  if (typeof type === "string") {
    clone.type = type === "null" ? ["null"] : [type, "null"];
  } else if (Array.isArray(type)) {
    const types = type.filter((candidate): candidate is string => typeof candidate === "string");
    clone.type = types.includes("null") ? types : [...types, "null"];
  } else {
    clone.type = ["null"];
  }
  if (Array.isArray(clone.enum) && !clone.enum.includes(null)) {
    clone.enum = clone.enum.concat([null]);
  }
  return clone;
}

function requiredSchema(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${name} must be a schema object`);
  return value;
}

function requiredPlainObject(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`${name} must be an object`);
  return value;
}

function requiredArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function staticAssert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Blanks comment, string, template-text, and regex bodies (index-preserving) so
 * structural scans see only code. Template interpolations (`${…}`) ARE code —
 * `\`${(meta.phases[0].name = "x")}\`` mutates the binding just like a bare
 * statement — so their contents stay visible (with nested strings/comments/regex
 * masked recursively) and the `${` / `}` delimiters are kept to hold brace depth
 * balanced for the depth trackers.
 */
function maskStaticJavaScriptSource(source: string): string {
  let output = "";
  let index = 0;

  // Masks a string/template literal starting at `index` (which points at the
  // opening quote). Template interpolations hand control back to maskCode.
  const maskStringLiteral = (quote: string): void => {
    // Keep the quote delimiters (mask only the contents) so isRegExpLiteralStart
    // still sees a value token after the literal and `"10" / 2` stays division.
    output += quote;
    index += 1;
    while (index < source.length) {
      const stringCurrent = source[index];
      staticAssert(
        stringCurrent != null,
        "maskStaticJavaScriptSource: string character is required"
      );
      if (isStaticTemplateInterpolationStart(source, index, quote)) {
        output += "${";
        index += 2;
        maskCode(true);
        if (index < source.length) {
          // maskCode stopped at the `}` closing the interpolation.
          output += "}";
          index += 1;
        }
        continue;
      }
      index += 1;
      if (stringCurrent === quote) {
        output += quote;
        break;
      }
      output += stringCurrent === "\n" ? "\n" : " ";
      if (stringCurrent === "\\") {
        if (index < source.length) {
          const escaped = source[index];
          staticAssert(
            escaped != null,
            "maskStaticJavaScriptSource: escaped character is required"
          );
          output += escaped === "\n" ? "\n" : " ";
          index += 1;
        }
      }
    }
  };

  // Masks code until the source ends or, inside a template interpolation, until
  // the unmatched `}` that closes it (left unconsumed for maskStringLiteral).
  const maskCode = (inInterpolation: boolean): void => {
    let braceDepth = 0;
    while (index < source.length) {
      const current = source[index];
      const next = source[index + 1];
      staticAssert(current != null, "maskStaticJavaScriptSource: current character is required");
      if (current === "/" && next === "/") {
        output += "  ";
        index += 2;
        while (index < source.length && source[index] !== "\n") {
          output += " ";
          index += 1;
        }
        continue;
      }
      if (current === "/" && next === "*") {
        output += "  ";
        index += 2;
        while (index < source.length) {
          const blockCurrent = source[index];
          const blockNext = source[index + 1];
          staticAssert(
            blockCurrent != null,
            "maskStaticJavaScriptSource: block character is required"
          );
          if (blockCurrent === "*" && blockNext === "/") {
            output += "  ";
            index += 2;
            break;
          }
          output += blockCurrent === "\n" ? "\n" : " ";
          index += 1;
        }
        continue;
      }
      if (current === "/" && isRegExpLiteralStart(output)) {
        // Mask regex literal bodies: characters like "//", "(", or "[" inside a regex
        // (e.g. /https:\/\// or /\/\*[\s\S]*?\*\//) must not be misread as comments or
        // counted toward bracket depth, which would unbalance the masked source.
        // Regex literals cannot span lines, so a candidate without a closing "/" on the
        // same line must be division whose left operand the heuristic did not recognize
        // (e.g. `count++ / total` or `{ valueOf() {...} } / 2`); leave it unmasked
        // instead of swallowing the rest of the line and hiding real exports.
        const closingIndex = findRegExpLiteralEnd(source, index);
        if (closingIndex !== -1) {
          // Keep the "/" delimiters (mask only the body) so isRegExpLiteralStart still
          // sees the literal as a value and `/x/ / 2` stays division.
          output += "/";
          index += 1;
          while (index < closingIndex) {
            output += " ";
            index += 1;
          }
          output += "/";
          index += 1;
          continue;
        }
      }
      if (current === '"' || current === "'" || current === "`") {
        maskStringLiteral(current);
        continue;
      }
      if (inInterpolation) {
        // Braces inside the interpolation (object literals, arrow bodies) nest;
        // the first unmatched `}` ends the interpolation.
        if (current === "{") braceDepth += 1;
        else if (current === "}") {
          if (braceDepth === 0) return;
          braceDepth -= 1;
        }
      }
      output += current;
      index += 1;
    }
  };

  maskCode(false);
  staticAssert(output.length === source.length, "maskStaticJavaScriptSource must preserve indexes");
  return output;
}

/**
 * Returns the index of the "/" closing the regex literal opened at openIndex, or -1
 * when the literal does not close before the end of the line/source (in which case
 * the opening "/" cannot be a regex literal). Honors "\" escapes and [...] character
 * classes, inside which "/" does not terminate the literal.
 */
function findRegExpLiteralEnd(source: string, openIndex: number): number {
  staticAssert(source[openIndex] === "/", "findRegExpLiteralEnd: openIndex must point at '/'");
  let index = openIndex + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const character = source[index];
    staticAssert(character != null, "findRegExpLiteralEnd: character is required");
    if (character === "\n") {
      return -1;
    }
    if (character === "\\") {
      // Skip the escaped character unless it is a newline (which still ends the line).
      index += source[index + 1] === "\n" ? 1 : 2;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
    } else if (character === "]") {
      inCharacterClass = false;
    } else if (character === "/" && !inCharacterClass) {
      return index;
    }
    index += 1;
  }
  return -1;
}

// Keywords after which "/" begins a regex literal rather than division (e.g. `return /x/`).
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/;

/**
 * Heuristic lexer rule for "/" disambiguation: division follows a value (identifier,
 * number, "]", a kept string/regex delimiter, postfix ++/--, an object-literal "}",
 * or a call/grouping ")"); a regex literal follows an operator, punctuation, start of
 * file, a keyword like `return`, a block "}", or a control-header ")". Receives the
 * already masked prefix so comment/string/regex contents never influence the decision.
 */
function isRegExpLiteralStart(maskedPrefix: string): boolean {
  let index = maskedPrefix.length - 1;
  while (index >= 0) {
    const character = maskedPrefix[index];
    if (character === " " || character === "\n" || character === "\t" || character === "\r") {
      index -= 1;
      continue;
    }
    break;
  }
  if (index < 0) {
    return true;
  }
  const character = maskedPrefix[index];
  staticAssert(character != null, "isRegExpLiteralStart: character is required");
  if (IDENTIFIER_CHARACTER.test(character)) {
    let start = index;
    while (start >= 0) {
      const wordCharacter = maskedPrefix[start];
      staticAssert(wordCharacter != null, "isRegExpLiteralStart: word character is required");
      if (!IDENTIFIER_CHARACTER.test(wordCharacter)) {
        break;
      }
      start -= 1;
    }
    return REGEX_PRECEDING_KEYWORDS.has(maskedPrefix.slice(start + 1, index + 1));
  }
  if (character === "+" || character === "-") {
    // Postfix increment/decrement ends a value, so `count++ / total` is division.
    // Require exactly two: `a+++/x/` lexes as `a++ + /x/`, a regex context.
    return !(maskedPrefix[index - 1] === character && maskedPrefix[index - 2] !== character);
  }
  if (character === "}") {
    // "}" is ambiguous: an object literal end is a value (division follows), while a
    // block end is statement position (regex follows). Classify by what introduced
    // the matching "{".
    return !isObjectLiteralEnd(maskedPrefix, index);
  }
  if (character === ")") {
    // ")" is ambiguous too: a control-statement header (`if (x) /re/.test(s)`) is
    // followed by statement position, while a call/grouping result is a value.
    return isControlHeaderEnd(maskedPrefix, index);
  }
  if (character === "/") {
    // A kept "/" is either the closing delimiter of a masked regex literal or a
    // division operator. Skipping the space-masked body backwards lands on the
    // opening "/" only in the regex case: the literal is a value, so division
    // follows (`/x/ / 2`). A division operator is preceded by its value operand
    // instead, so the current slash opens a regex (`a / /re/.source`).
    let before = index - 1;
    while (before >= 0 && (maskedPrefix[before] === " " || maskedPrefix[before] === "\n")) {
      before -= 1;
    }
    return !(before >= 0 && maskedPrefix[before] === "/");
  }
  // Values end with "]" or a kept quote delimiter of a masked literal;
  // a "/" after any of these is division, not a regex literal.
  return character !== "]" && character !== '"' && character !== "'" && character !== "`";
}

// Keywords whose parenthesized header is followed by statement position, so a "/"
// after the closing ")" starts a regex (e.g. `if (x) /re/.test(s)`).
const PAREN_STATEMENT_KEYWORDS = new Set(["if", "while", "for", "switch", "with"]);

/**
 * Determines whether the ")" at closeParenIndex ends a control-statement header by
 * finding the matching "(" in the masked prefix and checking whether a control
 * keyword precedes it.
 */
function isControlHeaderEnd(maskedPrefix: string, closeParenIndex: number): boolean {
  staticAssert(
    maskedPrefix[closeParenIndex] === ")",
    "isControlHeaderEnd: index must point at ')'"
  );
  let depth = 0;
  let openParenIndex = -1;
  for (let index = closeParenIndex; index >= 0; index -= 1) {
    const character = maskedPrefix[index];
    if (character === ")") {
      depth += 1;
    } else if (character === "(") {
      depth -= 1;
      if (depth === 0) {
        openParenIndex = index;
        break;
      }
    }
  }
  if (openParenIndex <= 0) {
    return false;
  }
  let index = openParenIndex - 1;
  while (index >= 0) {
    const character = maskedPrefix[index];
    if (character === " " || character === "\n" || character === "\t" || character === "\r") {
      index -= 1;
      continue;
    }
    break;
  }
  if (index < 0) {
    return false;
  }
  const character = maskedPrefix[index];
  staticAssert(character != null, "isControlHeaderEnd: character is required");
  if (!IDENTIFIER_CHARACTER.test(character)) {
    return false;
  }
  let start = index;
  while (start >= 0) {
    const wordCharacter = maskedPrefix[start];
    staticAssert(wordCharacter != null, "isControlHeaderEnd: word character is required");
    if (!IDENTIFIER_CHARACTER.test(wordCharacter)) {
      break;
    }
    start -= 1;
  }
  return PAREN_STATEMENT_KEYWORDS.has(maskedPrefix.slice(start + 1, index + 1));
}

// Keywords that expect an expression next, so a following "{" opens an object literal
// (e.g. `return {}`). Unlike REGEX_PRECEDING_KEYWORDS this excludes do/else, which
// introduce blocks.
const OBJECT_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "yield",
  "await",
]);

/**
 * Determines whether the "}" at closeBraceIndex ends an object literal (a value) or a
 * block (statement position) by finding the matching "{" in the masked prefix and
 * inspecting the token before it. Block contexts are enumerated (")", ";", "{", "}",
 * "=>", block keywords like `do`/`else`, file start); any other preceding operator or
 * punctuation ("=", "(", "[", ",", ":", "?", "||", arithmetic, ...) leaves the "{" in
 * expression position, so it opens an object literal.
 */
function isObjectLiteralEnd(maskedPrefix: string, closeBraceIndex: number): boolean {
  staticAssert(
    maskedPrefix[closeBraceIndex] === "}",
    "isObjectLiteralEnd: index must point at '}'"
  );
  let depth = 0;
  let openBraceIndex = -1;
  for (let index = closeBraceIndex; index >= 0; index -= 1) {
    const character = maskedPrefix[index];
    if (character === "}") {
      depth += 1;
    } else if (character === "{") {
      depth -= 1;
      if (depth === 0) {
        openBraceIndex = index;
        break;
      }
    }
  }
  if (openBraceIndex <= 0) {
    // Unmatched or file-initial "{": statement-position block.
    return false;
  }
  let index = openBraceIndex - 1;
  while (index >= 0) {
    const character = maskedPrefix[index];
    if (character === " " || character === "\n" || character === "\t" || character === "\r") {
      index -= 1;
      continue;
    }
    break;
  }
  if (index < 0) {
    return false;
  }
  const character = maskedPrefix[index];
  staticAssert(character != null, "isObjectLiteralEnd: character is required");
  if (IDENTIFIER_CHARACTER.test(character)) {
    let start = index;
    while (start >= 0) {
      const wordCharacter = maskedPrefix[start];
      staticAssert(wordCharacter != null, "isObjectLiteralEnd: word character is required");
      if (!IDENTIFIER_CHARACTER.test(wordCharacter)) {
        break;
      }
      start -= 1;
    }
    // Expression keywords (return, typeof, ...) take object literals; any other
    // identifier (do/else/try/finally, class names, function headers) opens a block.
    return OBJECT_PRECEDING_KEYWORDS.has(maskedPrefix.slice(start + 1, index + 1));
  }
  if (character === ")" || character === ";" || character === "{" || character === "}") {
    // Control headers (`if (...) {`), statement boundaries, and adjacent blocks.
    return false;
  }
  if (character === ">" && maskedPrefix[index - 1] === "=") {
    // "=>" introduces an arrow function block body.
    return false;
  }
  // Any other punctuation ("=", "(", "[", ",", ":", "?", "&", "|", arithmetic, ...)
  // keeps the "{" in expression position: object literal.
  return true;
}

function isTopLevelStaticMatch(maskedSource: string, matchIndex: number): boolean {
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  for (let index = 0; index < matchIndex; index += 1) {
    const character = maskedSource[index];
    staticAssert(character != null, "isTopLevelStaticMatch: character is required");
    switch (character) {
      case "{":
        braceDepth += 1;
        break;
      case "}":
        braceDepth = Math.max(0, braceDepth - 1);
        break;
      case "[":
        bracketDepth += 1;
        break;
      case "]":
        bracketDepth = Math.max(0, bracketDepth - 1);
        break;
      case "(":
        parenDepth += 1;
        break;
      case ")":
        parenDepth = Math.max(0, parenDepth - 1);
        break;
    }
  }
  return braceDepth === 0 && bracketDepth === 0 && parenDepth === 0;
}
