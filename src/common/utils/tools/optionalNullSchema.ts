import {
  validateJsonSchemaSubset,
  validateJsonSchemaSubsetSchema,
} from "@/common/utils/jsonSchemaSubset";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function containsReferenceKeyword(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsReferenceKeyword);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (["$ref", "$dynamicRef", "$recursiveRef"].some((key) => Object.hasOwn(value, key))) {
    return true;
  }
  return Object.values(value).some(containsReferenceKeyword);
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
 * this is exact for resolvable schemas. A schema with an unresolved reference
 * or outside the supported subset proves nothing, so it does not reject.
 */
function rejectsNull(schema: unknown): boolean {
  if (schema === true) {
    return false;
  }
  if (schema === false) {
    return true;
  }
  if (containsReferenceKeyword(schema) || !validateJsonSchemaSubsetSchema(schema).success) {
    return false;
  }
  return !validateJsonSchemaSubset(schema, null).success;
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

function widenSchemaNode(schema: unknown, inheritedRequired = new Set<string>()): void {
  if (!isRecord(schema)) {
    return;
  }

  const required = new Set([...inheritedRequired, ...getRequiredProperties(schema)]);
  if (isRecord(schema.properties)) {
    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      const modelSchema =
        !required.has(propertyName) && rejectsNull(propertySchema)
          ? makeNullableSchema(propertySchema)
          : propertySchema;
      schema.properties[propertyName] = modelSchema;
      widenSchemaNode(modelSchema);
    }
  }

  const items = schema.items;
  if (Array.isArray(items)) {
    for (const itemSchema of items) {
      widenSchemaNode(itemSchema);
    }
  } else {
    widenSchemaNode(items);
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        widenSchemaNode(branch, required);
      }
    }
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
  if (containsReferenceKeyword(schema)) {
    // Reference resolution is incomplete here, so leave the model schema alone
    // and let the provider decode without strict mode. `restore` stays: it only
    // removes placeholders the source schema provably rejects.
    return { modelSchema: structuredClone(schema), strict: false, restore };
  }
  return { modelSchema: widenOptionalPropertiesToNullable(schema), strict: undefined, restore };
}

/**
 * Apply Mux's nullish optional-property convention to a third-party JSON Schema.
 * The model contract only widens the source contract, so every provider can use it.
 */
export function widenOptionalPropertiesToNullable(schema: unknown): unknown {
  const modelSchema = structuredClone(schema);
  widenSchemaNode(modelSchema);
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
function isOmissionPlaceholder(
  propertySchema: unknown,
  value: unknown,
  options: OmissionPlaceholderOptions
): boolean {
  if (value === "") {
    return options.emptyStringIsOmission;
  }
  return value === null && rejectsNull(propertySchema);
}

function schemaAcceptsValue(schema: unknown, value: unknown): boolean {
  if (schema === true) {
    return true;
  }
  if (schema === false) {
    return false;
  }
  return validateJsonSchemaSubset(schema, value).success;
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

/**
 * Delete the placeholders among this level's declared properties that
 * `context` does not need for this instance. Whether a property is needed
 * depends on the instance (if/then, dependencies, minProperties, a union
 * inside then), so the validator decides, one deletion at a time: a deletion
 * that would turn an instance the context accepts into one it rejects is
 * undone. `null` placeholders go first: the property schema rejects them, so
 * deleting one never loses acceptance, and by the time `""` placeholders are
 * judged, acceptance reflects the best this instance can reach. Statically
 * required properties are never placeholders; when the context is outside the
 * validator's subset nothing is accepted, so that list is the only evidence.
 */
function deleteOmissionPlaceholders(
  properties: Record<string, unknown>,
  restored: Record<string, unknown>,
  context: unknown,
  options: OmissionPlaceholderOptions
): void {
  const alwaysRequired = isRecord(context) ? getRequiredProperties(context) : new Set<string>();
  const placeholders = Object.entries(properties)
    .filter(
      ([propertyName, propertySchema]) =>
        propertyName in restored &&
        !alwaysRequired.has(propertyName) &&
        isOmissionPlaceholder(propertySchema, restored[propertyName], options)
    )
    .map(([propertyName]) => propertyName);
  const nulls = placeholders.filter((propertyName) => restored[propertyName] === null);
  const emptyStrings = placeholders.filter((propertyName) => restored[propertyName] !== null);
  let accepted = schemaAcceptsValue(context, restored);
  for (const propertyName of [...nulls, ...emptyStrings]) {
    const placeholder = restored[propertyName];
    delete restored[propertyName];
    const stillAccepted = schemaAcceptsValue(context, restored);
    if (accepted && !stillAccepted) {
      restored[propertyName] = placeholder;
    } else {
      accepted = stillAccepted;
    }
  }
}

/**
 * Restore the properties and items this schema node declares directly
 * (including through allOf), then delete the placeholders that `context` does
 * not need for this instance. `context` is the schema in force at this
 * instance level: the node itself, conjoined with the union branches chosen on
 * the way in (see restoreNode). Union branches are the caller's concern.
 */
function restoreStructure(
  schema: Record<string, unknown>,
  value: unknown,
  context: unknown,
  options: OmissionPlaceholderOptions
): unknown {
  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    let restored: unknown = Array.isArray(itemSchema)
      ? value.map((item, index) => restoreNode(itemSchema[index], item, itemSchema[index], options))
      : value.map((item) => restoreNode(itemSchema, item, itemSchema, options));
    for (const subSchema of getAllOfBranches(schema)) {
      restored = restoreNode(subSchema, restored, context, options);
    }
    return restored;
  }
  if (!isRecord(value)) {
    return value;
  }
  const restored: Record<string, unknown> = { ...value };
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    // Children first, so this level is judged on restored values.
    if (propertyName in restored) {
      restored[propertyName] = restoreNode(
        propertySchema,
        restored[propertyName],
        propertySchema,
        options
      );
    }
  }
  deleteOmissionPlaceholders(properties, restored, context, options);
  let result: unknown = restored;
  for (const subSchema of getAllOfBranches(schema)) {
    result = restoreNode(subSchema, result, context, options);
  }
  return result;
}

function restoreNode(
  schema: unknown,
  value: unknown,
  context: unknown,
  options: OmissionPlaceholderOptions
): unknown {
  if (!isRecord(schema)) {
    return value;
  }
  const branches = getUnionBranches(schema);
  if (branches.length === 0) {
    return restoreStructure(schema, value, context, options);
  }

  // A union requires nothing until a branch is chosen, and a branch that
  // accepts the raw value gives that value meaning (an explicit null a nullable
  // branch allows, a "" a branch requires). So try the raw-accepting branches
  // first; for each candidate branch, conjoin it with the context so its
  // constraints apply while restoring this level and the branch's own
  // structure. The first branch that accepts its candidate wins.
  const rawAccepting = branches.filter((branch) => schemaAcceptsValue(branch, value));
  const ordered = [...rawAccepting, ...branches.filter((branch) => !rawAccepting.includes(branch))];
  for (const branch of ordered) {
    const branchContext = { allOf: [context, branch] };
    const candidate = restoreNode(
      branch,
      restoreStructure(schema, value, branchContext, options),
      branchContext,
      options
    );
    if (schemaAcceptsValue(branch, candidate)) {
      return candidate;
    }
  }
  // No candidate satisfies its branch. Never turn a valid payload into an
  // invalid one: keep a raw value some branch accepted, else strip best-effort.
  return rawAccepting.length > 0 ? value : restoreStructure(schema, value, context, options);
}

/**
 * Restore a third-party executor contract from a model payload by removing the
 * placeholder values the model used for omitted optional properties (see
 * isOmissionPlaceholder). Required properties and source-nullable values stay.
 */
export function stripOmissionPlaceholders(
  schema: unknown,
  value: unknown,
  options: OmissionPlaceholderOptions
): unknown {
  return restoreNode(schema, value, schema, options);
}
