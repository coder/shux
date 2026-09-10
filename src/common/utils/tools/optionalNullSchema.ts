import { validateJsonSchemaSubset } from "@/common/utils/jsonSchemaSubset";

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

type Nullability = "allows" | "rejects" | "unknown";

function combineAll(states: Nullability[]): Nullability {
  if (states.includes("rejects")) {
    return "rejects";
  }
  return states.includes("unknown") ? "unknown" : "allows";
}

function getNullability(schema: unknown): Nullability {
  if (schema === true) {
    return "allows";
  }
  if (schema === false) {
    return "rejects";
  }
  if (!isRecord(schema)) {
    return "unknown";
  }

  const constraints: Nullability[] = [];
  if (Object.hasOwn(schema, "$ref")) {
    constraints.push("unknown");
  }
  if (typeof schema.type === "string") {
    constraints.push(schema.type === "null" ? "allows" : "rejects");
  } else if (Array.isArray(schema.type)) {
    constraints.push(schema.type.includes("null") ? "allows" : "rejects");
  }
  if (Array.isArray(schema.enum)) {
    constraints.push(schema.enum.includes(null) ? "allows" : "rejects");
  }
  if (Object.hasOwn(schema, "const")) {
    constraints.push(schema.const === null ? "allows" : "rejects");
  }
  if (Array.isArray(schema.anyOf)) {
    const states = schema.anyOf.map(getNullability);
    constraints.push(
      states.includes("allows") ? "allows" : states.includes("unknown") ? "unknown" : "rejects"
    );
  }
  if (Array.isArray(schema.oneOf)) {
    const states = schema.oneOf.map(getNullability);
    const allowedCount = states.filter((state) => state === "allows").length;
    constraints.push(
      states.includes("unknown") ? "unknown" : allowedCount === 1 ? "allows" : "rejects"
    );
  }
  if (Array.isArray(schema.allOf)) {
    constraints.push(combineAll(schema.allOf.map(getNullability)));
  }
  if (Object.hasOwn(schema, "not")) {
    const state = getNullability(schema.not);
    constraints.push(state === "allows" ? "rejects" : state === "rejects" ? "allows" : "unknown");
  }
  if (Object.hasOwn(schema, "if")) {
    constraints.push("unknown");
  }

  return constraints.length === 0 ? "allows" : combineAll(constraints);
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
        !required.has(propertyName) && getNullability(propertySchema) === "rejects"
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

export function createOptionalNullSchemaContract(schema: unknown): OptionalNullSchemaContract {
  const restore = (value: unknown) => stripOmissionPlaceholders(schema, value);
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
 *   instead of omitting them, and strict REST-backed MCP servers reject
 *   present-but-empty arguments (#2887).
 * A `null` the source schema accepts is not a placeholder: the server may give it
 * meaning ("clear this field"). Callers never treat required properties as
 * placeholders for the same reason.
 */
function isOmissionPlaceholder(propertySchema: unknown, value: unknown): boolean {
  if (value === "") {
    return true;
  }
  return value === null && getNullability(propertySchema) === "rejects";
}

function stripProperties(
  value: Record<string, unknown>,
  properties: Record<string, unknown>,
  required: ReadonlySet<string>
): Record<string, unknown> {
  const stripped = { ...value };
  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    if (!(propertyName in stripped)) {
      continue;
    }
    if (
      !required.has(propertyName) &&
      isOmissionPlaceholder(propertySchema, stripped[propertyName])
    ) {
      delete stripped[propertyName];
      continue;
    }
    stripped[propertyName] = stripOmissionPlaceholders(propertySchema, stripped[propertyName]);
  }
  return stripped;
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

function stripMatchingUnionBranch(
  schema: Record<string, unknown>,
  value: unknown,
  inheritedRequired: ReadonlySet<string>
): unknown {
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }
    // A branch that accepts the raw value gives that value meaning (for example
    // a nullable property another branch declares non-nullable), so prefer it
    // over a branch that only accepts the stripped value.
    for (const branch of branches) {
      if (schemaAcceptsValue(branch, value)) {
        return value;
      }
    }
    for (const branch of branches) {
      const stripped = stripNode(branch, value, inheritedRequired);
      if (schemaAcceptsValue(branch, stripped)) {
        return stripped;
      }
    }
  }
  return null;
}

function stripNode(
  schema: unknown,
  value: unknown,
  inheritedRequired: ReadonlySet<string>
): unknown {
  if (!isRecord(schema)) {
    return value;
  }

  const required = new Set([...inheritedRequired, ...getRequiredProperties(schema)]);
  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    const stripped = Array.isArray(itemSchema)
      ? value.map((item, index) => stripNode(itemSchema[index], item, new Set()))
      : value.map((item) => stripNode(itemSchema, item, new Set()));
    return stripMatchingUnionBranch(schema, stripped, required) ?? stripped;
  }
  if (!isRecord(value)) {
    return value;
  }

  const stripped = stripObjectNode(schema, value, required);
  const matched = stripMatchingUnionBranch(schema, stripped, required);
  if (matched !== null) {
    return matched;
  }
  // No branch accepts the stripped value. A sibling anyOf/oneOf branch can
  // require a property the root declares optional (a discriminated "error"
  // branch requiring `message`), so its `""` was never an omission placeholder.
  // Retry with each branch's required properties treated as required and keep
  // the first result that branch accepts.
  for (const branch of getUnionBranches(schema)) {
    if (!isRecord(branch)) {
      continue;
    }
    const branchRequired = new Set([...required, ...getRequiredProperties(branch)]);
    const candidate = stripNode(
      branch,
      stripObjectNode(schema, value, branchRequired),
      branchRequired
    );
    if (schemaAcceptsValue(branch, candidate)) {
      return candidate;
    }
  }
  return stripped;
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

function stripObjectNode(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  required: ReadonlySet<string>
): Record<string, unknown> {
  let stripped = { ...value };
  if (isRecord(schema.properties)) {
    stripped = stripProperties(stripped, schema.properties, required);
  }
  if (Array.isArray(schema.allOf)) {
    for (const subSchema of schema.allOf) {
      stripped = stripNode(subSchema, stripped, required) as Record<string, unknown>;
    }
  }
  return stripped;
}

/**
 * Restore a third-party executor contract from a model payload by removing the
 * placeholder values the model used for omitted optional properties (see
 * isOmissionPlaceholder). Required properties and source-nullable values stay.
 */
export function stripOmissionPlaceholders(schema: unknown, value: unknown): unknown {
  return stripNode(schema, value, new Set());
}
