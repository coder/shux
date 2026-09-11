import { OPTIONAL_PLACEHOLDER_MAX_JUDGED } from "@/common/constants/toolLimits";
import {
  JSON_SCHEMA_SUBSET_MAX_DEPTH,
  compileJsonSchemaPattern,
  compileJsonSchemaSubset,
  getJsonSchemaDialect,
  validateJsonSchemaSubset,
  validateJsonSchemaSubsetSchema,
  type Dialect,
} from "@/common/utils/jsonSchemaSubset";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** `fn` computed once per distinct argument, for as long as the result lives. */
function memoize<K, V>(fn: (key: K) => V): (key: K) => V {
  const results = new Map<K, V>();
  return (key) => {
    let result = results.get(key);
    if (result === undefined) {
      result = fn(key);
      results.set(key, result);
    }
    return result;
  };
}

function getRequiredProperties(schema: Record<string, unknown>): Set<string> {
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : []
  );
  if (Array.isArray(schema.allOf)) {
    for (const subSchema of schema.allOf) {
      if (!isRecord(subSchema)) {
        continue;
      }
      for (const key of getRequiredProperties(subSchema)) {
        required.add(key);
      }
    }
  }
  return required;
}

/**
 * Whether the schema provably rejects `null`. The validator evaluates every
 * keyword it supports (type, enum, const, composition, not, if/then/else), so
 * this is exact for schemas in its subset. A schema outside it (a reference,
 * an unknown dialect, too deep, too large) proves nothing, so it does not reject.
 */
function rejectsNull(schema: unknown): boolean {
  if (schema === true) {
    return false;
  }
  if (schema === false) {
    return true;
  }
  return (
    validateJsonSchemaSubsetSchema(schema).success &&
    !validateJsonSchemaSubset(schema, null).success
  );
}

function makeNullableSchema(schema: unknown): Record<string, unknown> {
  const annotations = isRecord(schema)
    ? {
        ...(typeof schema.title === "string" ? { title: schema.title } : {}),
        ...(typeof schema.description === "string" ? { description: schema.description } : {}),
      }
    : {};
  return { ...annotations, anyOf: [schema, { type: "null" }] };
}

function getUnionBranches(schema: Record<string, unknown>): unknown[] {
  const branches: unknown[] = [];
  for (const keyword of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[keyword])) {
      branches.push(...(schema[keyword] as unknown[]));
    }
  }
  return branches;
}

function getAllOfBranches(schema: Record<string, unknown>): unknown[] {
  return Array.isArray(schema.allOf) ? (schema.allOf as unknown[]) : [];
}

/** Sub-schemas that apply to the same instance as `schema` when a condition holds. */
function getConditionalSubSchemas(schema: Record<string, unknown>): unknown[] {
  const dependents = [schema.dependentSchemas, schema.dependencies].flatMap((keyword) =>
    isRecord(keyword) ? Object.values(keyword).filter(isRecord) : []
  );
  return [...getUnionBranches(schema), schema.then, schema.else, ...dependents];
}

/** Sub-schemas that govern the properties `schema` does not name. */
function getDictionarySchemas(schema: Record<string, unknown>): unknown[] {
  return [
    ...(isRecord(schema.patternProperties) ? Object.values(schema.patternProperties) : []),
    schema.additionalProperties,
  ];
}

/**
 * The keywords a dialect spells a tuple with: the positional schemas, then the
 * schema of every item past them. A schema is read in its own dialect, as its
 * validator reads it, so the other spelling is an extension it ignores: a
 * `prefixItems` in a draft-07 schema governs nothing.
 */
function getTupleKeywords(dialect: Dialect): { positional: string; rest: string } {
  return dialect === "2020-12"
    ? { positional: "prefixItems", rest: "items" }
    : { positional: "items", rest: "additionalItems" };
}

/** Sub-schemas that govern array items, whichever index each applies to. */
function getItemSchemas(schema: Record<string, unknown>, dialect: Dialect): unknown[] {
  const { positional, rest } = getTupleKeywords(dialect);
  const tuple = schema[positional];
  return Array.isArray(tuple) ? [...(tuple as unknown[]), schema[rest]] : [schema.items];
}

/**
 * Widen every optional property the schema declares by name, wherever it
 * declares it. This walks the structure stripOmissionPlaceholders walks, so
 * every placeholder the model contract invites is one `restore` removes.
 */
function widenSchemaNode(
  schema: unknown,
  dialect: Dialect,
  inheritedRequired = new Set<string>()
): void {
  if (!isRecord(schema)) {
    return;
  }

  const required = new Set([...inheritedRequired, ...getRequiredProperties(schema)]);
  if (isRecord(schema.properties)) {
    // A matching `patternProperties` entry governs the name too. It is not
    // widened: it is a dictionary's contract, and the dictionary's entries
    // are data. The named declaration is, so a provider that drops or ignores
    // patterns still sees the invitation, and `restore` removes a null the
    // pattern rejects.
    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      const modelSchema =
        !required.has(propertyName) && rejectsNull(propertySchema)
          ? makeNullableSchema(propertySchema)
          : propertySchema;
      schema.properties[propertyName] = modelSchema;
      widenSchemaNode(modelSchema, dialect);
    }
  }
  for (const subSchema of [...getDictionarySchemas(schema), ...getItemSchemas(schema, dialect)]) {
    widenSchemaNode(subSchema, dialect);
  }
  for (const subSchema of [...getAllOfBranches(schema), ...getConditionalSubSchemas(schema)]) {
    widenSchemaNode(subSchema, dialect, required);
  }
}

/**
 * The two halves of a third-party JSON Schema tool contract:
 * - `modelSchema` (with `strict`) is what the provider and model see;
 * - `restore` maps a model payload back to the source schema the executor expects.
 */
export interface OptionalNullSchemaContract {
  modelSchema: unknown;
  strict: false | undefined;
  restore: (value: unknown) => unknown;
}

/**
 * Which values on an optional property count as "the model meant to omit this".
 * `null` where the source schema rejects it always does. `""` depends on who
 * consumes the payload, so each caller decides (see isOmissionPlaceholder).
 */
export interface OmissionPlaceholderOptions {
  emptyStringIsOmission: boolean;
}

export function createOptionalNullSchemaContract(
  schema: unknown,
  options: OmissionPlaceholderOptions
): OptionalNullSchemaContract {
  const restore = (value: unknown) => stripOmissionPlaceholders(schema, value, options);
  if (!validateJsonSchemaSubsetSchema(schema).success) {
    // The validator cannot judge this schema (a reference, an unknown dialect,
    // too deep, too large, invalid), so nothing here can either: the model
    // sees the source schema as is, and the provider decodes without strict
    // mode. `restore` stays: it only removes placeholders the source schema
    // provably rejects. The check is bounded, so no walk below runs on a
    // schema that could overflow the stack or, through one compilation per
    // optional property, hold the main process (the schema is server-authored).
    return { modelSchema: schema, strict: false, restore };
  }
  return { modelSchema: widenOptionalPropertiesToNullable(schema), strict: undefined, restore };
}

/**
 * Apply Mux's nullish optional-property convention to a third-party JSON Schema.
 * The model contract only widens the source contract, so every provider can use it.
 */
export function widenOptionalPropertiesToNullable(schema: unknown): unknown {
  const modelSchema = structuredClone(schema);
  widenSchemaNode(modelSchema, getJsonSchemaDialect(schema));
  return modelSchema;
}

/**
 * A model uses two placeholder values for an optional property it means to omit:
 * - `null`, because the model contract widens optional properties to nullable
 *   and strict-mode providers make the model emit every property; and
 * - `""`, because models habitually fill optional fields with an empty string
 *   instead of omitting them. Strict REST-backed MCP servers reject
 *   present-but-empty arguments (#2887), so MCP callers opt in. A workflow
 *   script reading its own report may give `""` meaning, so workflow callers
 *   do not.
 * A `null` the source schema accepts is not a placeholder: the server may give it
 * meaning ("clear this field"). Callers never treat required properties as
 * placeholders for the same reason.
 */
interface PlaceholderSite {
  parent: Record<string, unknown>;
  name: string;
  value: null | "";
  /** Every schema that declares this property; union branches may disagree on null. */
  declarations: Declaration[];
}

interface Declaration {
  schema: unknown;
  /**
   * Reached through a union branch, a then/else, or a dependent schema, so it
   * governs some instances of the parent, not all of them. An unconditional
   * declaration governs every instance.
   */
  conditional: boolean;
}

/** Placeholder sites by the object that holds them, then by property name. */
type PlaceholderSites = Map<Record<string, unknown>, Map<string, PlaceholderSite>>;

/** What one walk over a payload carries along. */
interface SiteWalk {
  dialect: Dialect;
  /**
   * Whether a key matches a pattern of the schema. Every key of a dictionary
   * meets every pattern, so each pattern is compiled at most once per payload,
   * whatever the shared pattern cache holds.
   */
  matches: (pattern: string, key: string) => boolean;
  sites: PlaceholderSites;
}

function getStaticRequired(schema: unknown): Set<string> {
  return isRecord(schema) ? getRequiredProperties(schema) : new Set<string>();
}

/**
 * The sub-schemas of `schema` that govern the property `name`, as JSON Schema
 * defines them: `properties[name]` and every matching `patternProperties`
 * entry, or else `additionalProperties`.
 */
function getPropertySchemas(
  schema: Record<string, unknown>,
  name: string,
  matches: SiteWalk["matches"]
): unknown[] {
  const governing: unknown[] = [];
  if (isRecord(schema.properties) && Object.hasOwn(schema.properties, name)) {
    governing.push(schema.properties[name]);
  }
  if (isRecord(schema.patternProperties)) {
    for (const [pattern, patternSchema] of Object.entries(schema.patternProperties)) {
      if (matches(pattern, name)) {
        governing.push(patternSchema);
      }
    }
  }
  return governing.length > 0 ? governing : [schema.additionalProperties];
}

/**
 * The sub-schema of `schema` that governs the array item at `index`: the
 * tuple's positional schema, the schema of the items past it, or `items` when
 * there is no tuple (see getTupleKeywords).
 */
function getItemSchema(schema: Record<string, unknown>, index: number, dialect: Dialect): unknown {
  const { positional, rest } = getTupleKeywords(dialect);
  const tuple = schema[positional];
  if (Array.isArray(tuple)) {
    return index < tuple.length ? (tuple as unknown[])[index] : schema[rest];
  }
  return schema.items;
}

/**
 * Set an own property, as JSON.parse does. `parent[name] = value` on a name
 * like `__proto__` reaches the prototype's accessor once the own property is
 * deleted, and the key never returns to the payload.
 */
function setOwnProperty(parent: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(parent, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Walk the schema and payload together and record every property the schema
 * declares by name whose value is `null` or `""`, with each declaration: allOf,
 * anyOf/oneOf branches, then/else, and dependent schemas all apply to the same
 * instance, so one property can have several, and a matching
 * `patternProperties` entry governs the name alongside `properties[name]`. A
 * declaration reached through a union branch, then/else, or a dependent schema
 * is conditional. Properties a dictionary holds (`additionalProperties`,
 * `patternProperties`) are data, not declared optional properties, so they are
 * walked but are not sites themselves. `required` is what this level requires
 * unconditionally (the node's own list and its allOf's); those properties are
 * never placeholders. A branch's own `required` is conditional, so the root
 * verdict judges it instead. The walk is bounded like the validator's, so a
 * schema too deep to judge is also too deep to restore.
 */
function collectPlaceholderSites(
  schema: unknown,
  value: unknown,
  required: ReadonlySet<string>,
  conditional: boolean,
  depth: number,
  walk: SiteWalk
): void {
  if (depth > JSON_SCHEMA_SUBSET_MAX_DEPTH || !isRecord(schema)) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const itemSchema = getItemSchema(schema, index, walk.dialect);
      collectPlaceholderSites(
        itemSchema,
        item,
        getStaticRequired(itemSchema),
        conditional,
        depth + 1,
        walk
      );
    });
  } else if (isRecord(value)) {
    for (const [name, propertyValue] of Object.entries(value)) {
      const governing = getPropertySchemas(schema, name, walk.matches);
      if (
        isRecord(schema.properties) &&
        Object.hasOwn(schema.properties, name) &&
        !required.has(name) &&
        (propertyValue === null || propertyValue === "")
      ) {
        const siblings = walk.sites.get(value) ?? new Map<string, PlaceholderSite>();
        const site = siblings.get(name) ?? {
          parent: value,
          name,
          value: propertyValue,
          declarations: [],
        };
        for (const declaration of governing) {
          site.declarations.push({ schema: declaration, conditional });
        }
        siblings.set(name, site);
        walk.sites.set(value, siblings);
      }
      for (const propertySchema of governing) {
        collectPlaceholderSites(
          propertySchema,
          propertyValue,
          getStaticRequired(propertySchema),
          conditional,
          depth + 1,
          walk
        );
      }
    }
  }
  for (const subSchema of getAllOfBranches(schema)) {
    collectPlaceholderSites(subSchema, value, required, conditional, depth + 1, walk);
  }
  for (const subSchema of getConditionalSubSchemas(schema)) {
    collectPlaceholderSites(subSchema, value, required, true, depth + 1, walk);
  }
}

/**
 * Compile `schema` into a verdict on instances, so a loop of verdicts pays for
 * the schema once. A schema the validator cannot judge accepts nothing.
 */
function compileAcceptance(schema: unknown): (value: unknown) => boolean {
  if (schema === true) {
    return () => true;
  }
  if (schema === false) {
    return () => false;
  }
  return compileJsonSchemaSubset(schema) ?? (() => false);
}

/**
 * Restore a third-party executor contract from a model payload by removing the
 * placeholder values the model used for omitted optional properties (see
 * PlaceholderSite). Required properties and source-nullable values stay.
 *
 * Whether a placeholder may go is a question about the whole payload, because
 * a constraint can come from any ancestor (a root `then` that requires a
 * nested property, `dependencies`, `minProperties`, a union inside `then`, a
 * union branch whose sibling declares the property nullable), so the root
 * schema judges. A `null` an unconditional declaration rejects is deleted
 * outright: the payload is rejected while it stays, whatever else applies. A
 * `null` only a conditional declaration rejects is judged with the `""`s,
 * because another branch may accept it, whether it declares the property or
 * leaves it open. Then the plain reading comes first: every `""` is an
 * omission, and when the root accepts that, it is the answer, with any
 * remaining `null` standing where the schema accepts it. Otherwise the
 * remaining `null`s go too, and if that is not accepted either, each
 * placeholder is judged alone, from a reading the root accepts: the model's
 * payload, or else the omitted reading with its placeholders returned one at a
 * time, in payload order, until the root accepts (a union whose branches
 * disagree about several placeholders at once needs this). From there a `""`
 * goes and a `null` stands while the root keeps accepting; a change it rejects
 * is undone. When the root accepts no reading, the omitted one stands. Cost:
 * the root is compiled once, then at most two verdicts per judged placeholder
 * plus three, each linear in the payload; past OPTIONAL_PLACEHOLDER_MAX_JUDGED
 * they are kept, which never invalidates a valid payload. A root the validator
 * cannot judge accepts nothing, so only the static `required` lists protect a
 * `""` there.
 */
export function stripOmissionPlaceholders(
  schema: unknown,
  value: unknown,
  options: OmissionPlaceholderOptions
): unknown {
  const restored: unknown = structuredClone(value);
  const compilePatternOnce = memoize(compileJsonSchemaPattern);
  const walk: SiteWalk = {
    dialect: getJsonSchemaDialect(schema),
    matches: (pattern, key) => compilePatternOnce(pattern)(key),
    sites: new Map(),
  };
  collectPlaceholderSites(schema, restored, getStaticRequired(schema), false, 0, walk);
  // Every item of an array and every entry of a dictionary repeats the same
  // declaration, and each verdict walks and serializes its schema.
  const rejectsNullOnce = memoize(rejectsNull);
  const emptyStrings: PlaceholderSite[] = [];
  const nulls: PlaceholderSite[] = [];
  for (const site of [...walk.sites.values()].flatMap((siblings) => [...siblings.values()])) {
    if (site.value === "") {
      if (options.emptyStringIsOmission) {
        emptyStrings.push(site);
      }
      continue;
    }
    const rejecting = site.declarations.filter((declaration) =>
      rejectsNullOnce(declaration.schema)
    );
    if (rejecting.some((declaration) => !declaration.conditional)) {
      delete site.parent[site.name];
    } else if (rejecting.length > 0) {
      nulls.push(site);
    }
  }
  const judged = [...nulls, ...emptyStrings];
  if (judged.length === 0) {
    return restored;
  }
  const accepts = compileAcceptance(schema);
  const omit = (sites: PlaceholderSite[]) => {
    for (const site of sites) {
      delete site.parent[site.name];
    }
  };
  const keep = (sites: PlaceholderSite[]) => {
    for (const site of sites) {
      setOwnProperty(site.parent, site.name, site.value);
    }
  };
  omit(emptyStrings);
  if (accepts(restored)) {
    return restored;
  }
  if (nulls.length > 0) {
    omit(nulls);
    if (accepts(restored)) {
      return restored;
    }
  }
  keep(judged);
  if (judged.length > OPTIONAL_PLACEHOLDER_MAX_JUDGED) {
    return restored;
  }
  let accepted = accepts(restored);
  if (!accepted) {
    omit(judged);
    for (const site of judged) {
      keep([site]);
      accepted = accepts(restored);
      if (accepted) {
        break;
      }
    }
  }
  if (!accepted) {
    omit(judged);
    return restored;
  }
  for (const site of judged) {
    const stands = site.value === null;
    if (Object.hasOwn(site.parent, site.name) === stands) {
      continue;
    }
    (stands ? keep : omit)([site]);
    if (!accepts(restored)) {
      (stands ? omit : keep)([site]);
    }
  }
  return restored;
}
