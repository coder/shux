import { type Tool } from "ai";

/**
 * JSON Schema properties that are not permitted by OpenAI's Responses API.
 *
 * OpenAI's Structured Outputs has stricter JSON Schema validation than other providers.
 * MCP tools may have schemas with these properties which work fine with Anthropic
 * but fail with OpenAI. We strip these properties to ensure compatibility.
 *
 * @see https://platform.openai.com/docs/guides/structured-outputs
 * @see https://github.com/vercel/ai/discussions/5164
 */
const OPENAI_UNSUPPORTED_SCHEMA_PROPERTIES = new Set([
  // String validation
  "minLength",
  "maxLength",
  "pattern",
  "format",
  // Number validation
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  // Array validation
  "minItems",
  "maxItems",
  "uniqueItems",
  // Object validation
  "minProperties",
  "maxProperties",
  // General
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  // Composition (partially supported - strip from items/properties)
  // Note: oneOf/anyOf at root level may work, but not in nested contexts
]);

/**
 * Recursively strip unsupported schema properties for OpenAI compatibility.
 * This mutates the schema in place for efficiency.
 */
function stripUnsupportedProperties(schema: unknown): void {
  if (typeof schema !== "object" || schema === null) {
    return;
  }

  const obj = schema as Record<string, unknown>;

  // Remove unsupported properties at this level
  for (const prop of OPENAI_UNSUPPORTED_SCHEMA_PROPERTIES) {
    if (prop in obj) {
      delete obj[prop];
    }
  }

  // Recursively process nested schemas
  if (obj.properties && typeof obj.properties === "object") {
    for (const propSchema of Object.values(obj.properties as Record<string, unknown>)) {
      stripUnsupportedProperties(propSchema);
    }
  }

  if (obj.items) {
    if (Array.isArray(obj.items)) {
      for (const itemSchema of obj.items) {
        stripUnsupportedProperties(itemSchema);
      }
    } else {
      stripUnsupportedProperties(obj.items);
    }
  }

  if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
    stripUnsupportedProperties(obj.additionalProperties);
  }

  // Handle anyOf/oneOf/allOf
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(obj[keyword])) {
      for (const subSchema of obj[keyword] as unknown[]) {
        stripUnsupportedProperties(subSchema);
      }
    }
  }

  // Handle definitions/defs (JSON Schema draft-07 and later)
  for (const defsKey of ["definitions", "$defs"]) {
    if (obj[defsKey] && typeof obj[defsKey] === "object") {
      for (const defSchema of Object.values(obj[defsKey] as Record<string, unknown>)) {
        stripUnsupportedProperties(defSchema);
      }
    }
  }
}

/**
 * Return a sanitized clone of a JSON Schema for OpenAI Responses API compatibility.
 */
export function sanitizeJsonSchemaForOpenAI<T>(schema: T): T {
  const clonedSchema = JSON.parse(JSON.stringify(schema)) as T;
  stripUnsupportedProperties(clonedSchema);
  return clonedSchema;
}

const OPENAI_WORKFLOW_REPORT_UNSUPPORTED_SCHEMA_PROPERTIES = new Set([
  "$defs",
  "$schema",
  "allOf",
  "default",
  "definitions",
  "dependentRequired",
  "dependentSchemas",
  "deprecated",
  "else",
  "examples",
  "if",
  "not",
  "readOnly",
  "then",
  "writeOnly",
]);

/**
 * Return an OpenAI-compatible clone of a workflow agent output schema.
 *
 * Workflow authors can use Ajv validation keywords for host-side validation; this
 * sanitizer keeps supported constraints (pattern, numeric bounds, array bounds,
 * enum, anyOf) but removes unsupported composition/annotation keys and makes
 * object schemas strict for OpenAI tool parameters.
 */
export function sanitizeWorkflowAgentReportSchemaForOpenAI<T>(schema: T): T {
  const clonedSchema = JSON.parse(JSON.stringify(schema)) as T;
  sanitizeWorkflowAgentReportSchemaNode(clonedSchema);
  return clonedSchema;
}

function makeWorkflowReportPropertyNullable(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { anyOf: [schema, { type: "null" }] };
  }

  const obj = schema as Record<string, unknown>;
  if (Array.isArray(obj.enum)) {
    const values: unknown[] = obj.enum;
    if (!values.includes(null)) {
      obj.enum = [...values, null];
    }
    return obj;
  }
  if (typeof obj.type === "string") {
    if (obj.type !== "null") {
      obj.type = [obj.type, "null"];
    }
    return obj;
  }
  if (Array.isArray(obj.type)) {
    const types: unknown[] = obj.type;
    if (!types.includes("null")) {
      obj.type = [...types, "null"];
    }
    return obj;
  }
  if (Array.isArray(obj.anyOf)) {
    const options: unknown[] = obj.anyOf;
    const hasNullOption = options.some(
      (option) =>
        option != null &&
        typeof option === "object" &&
        !Array.isArray(option) &&
        (option as { type?: unknown }).type === "null"
    );
    if (!hasNullOption) {
      obj.anyOf = [...options, { type: "null" }];
    }
    return obj;
  }
  return { anyOf: [obj, { type: "null" }] };
}

function getWorkflowReportRequiredProperties(schema: Record<string, unknown>): Set<string> {
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : []
  );
  if (Array.isArray(schema.allOf)) {
    for (const subSchema of schema.allOf) {
      if (subSchema == null || typeof subSchema !== "object" || Array.isArray(subSchema)) {
        continue;
      }
      for (const key of getWorkflowReportRequiredProperties(subSchema as Record<string, unknown>)) {
        required.add(key);
      }
    }
  }
  return required;
}

function mergeSchemaRecords(left: unknown, right: unknown): unknown {
  if (
    left != null &&
    typeof left === "object" &&
    !Array.isArray(left) &&
    right != null &&
    typeof right === "object" &&
    !Array.isArray(right)
  ) {
    return { ...(left as Record<string, unknown>), ...(right as Record<string, unknown>) };
  }
  return right;
}

function mergeAllOfObjectProperties(schema: Record<string, unknown>): void {
  if (!Array.isArray(schema.allOf)) {
    return;
  }
  for (const subSchema of schema.allOf) {
    if (subSchema == null || typeof subSchema !== "object" || Array.isArray(subSchema)) {
      continue;
    }
    const subSchemaRecord = subSchema as Record<string, unknown>;
    mergeAllOfObjectProperties(subSchemaRecord);
    if (subSchemaRecord.type === "object" && schema.type == null) {
      schema.type = "object";
    }
    if (subSchemaRecord.properties != null) {
      if (
        typeof subSchemaRecord.properties !== "object" ||
        Array.isArray(subSchemaRecord.properties)
      ) {
        continue;
      }
      schema.properties ??= {};
      if (typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
        continue;
      }
      const properties = schema.properties as Record<string, unknown>;
      for (const [propertyName, propertySchema] of Object.entries(
        subSchemaRecord.properties as Record<string, unknown>
      )) {
        properties[propertyName] = mergeSchemaRecords(properties[propertyName], propertySchema);
      }
    }
  }
  const required = getWorkflowReportRequiredProperties(schema);
  if (required.size > 0) {
    schema.required = [...required];
  }
}

function sanitizeWorkflowAgentReportSchemaNode(schema: unknown): void {
  if (typeof schema !== "object" || schema === null) {
    return;
  }

  const obj = schema as Record<string, unknown>;
  mergeAllOfObjectProperties(obj);
  const requiredBeforeSanitizing = getWorkflowReportRequiredProperties(obj);
  for (const prop of OPENAI_WORKFLOW_REPORT_UNSUPPORTED_SCHEMA_PROPERTIES) {
    if (prop in obj) {
      delete obj[prop];
    }
  }

  if (Array.isArray(obj.oneOf)) {
    if (!Array.isArray(obj.anyOf)) {
      obj.anyOf = obj.oneOf;
    }
    delete obj.oneOf;
  }

  const properties =
    obj.properties != null && typeof obj.properties === "object" && !Array.isArray(obj.properties)
      ? (obj.properties as Record<string, unknown>)
      : null;
  if (properties != null) {
    const originallyRequired = new Set(
      [...requiredBeforeSanitizing].filter((key) => key in properties)
    );
    obj.additionalProperties = false;
    obj.required = Object.keys(properties);
    for (const [propertyName, propSchema] of Object.entries(properties)) {
      sanitizeWorkflowAgentReportSchemaNode(propSchema);
      if (!originallyRequired.has(propertyName)) {
        properties[propertyName] = makeWorkflowReportPropertyNullable(propSchema);
      }
    }
  } else if (obj.type === "object") {
    obj.additionalProperties = false;
    if (!Array.isArray(obj.required)) {
      obj.required = [];
    }
  }

  if (Array.isArray(obj.items)) {
    for (const itemSchema of obj.items) {
      sanitizeWorkflowAgentReportSchemaNode(itemSchema);
    }
  } else if (obj.items != null) {
    sanitizeWorkflowAgentReportSchemaNode(obj.items);
  }

  for (const keyword of ["anyOf"] as const) {
    if (Array.isArray(obj[keyword])) {
      for (const subSchema of obj[keyword]) {
        sanitizeWorkflowAgentReportSchemaNode(subSchema);
      }
    }
  }
}

/**
 * Sanitize a tool's parameter schema for OpenAI Responses API compatibility.
 *
 * OpenAI's Responses API has stricter JSON Schema validation than other providers.
 * This function creates a new tool with sanitized parameters that strips
 * unsupported schema properties like minLength, maximum, default, etc.
 *
 * Tools can have schemas in two places:
 * - `parameters`: Used by tools created with ai SDK's `tool()` function
 * - `inputSchema`: Used by MCP tools created with `dynamicTool()` (see mcpClient.ts)
 *
 * @param tool - The original tool to sanitize
 * @returns A new tool with sanitized parameter schema
 */
export function sanitizeToolSchemaForOpenAI(tool: Tool): Tool {
  // Access tool internals - the AI SDK tool structure varies:
  // - Regular tools have `parameters` (Zod schema)
  // - MCP/dynamic tools have `inputSchema` (JSON Schema wrapper with getter)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  const toolRecord = tool as any as Record<string, unknown>;

  // Check for inputSchema first (MCP tools use this)
  // The inputSchema is a wrapper object with a jsonSchema getter
  if (toolRecord.inputSchema && typeof toolRecord.inputSchema === "object") {
    const inputSchemaWrapper = toolRecord.inputSchema as Record<string, unknown>;

    // Get the actual JSON Schema - it's exposed via a getter
    const rawJsonSchema = inputSchemaWrapper.jsonSchema;
    if (rawJsonSchema && typeof rawJsonSchema === "object") {
      // Deep clone and sanitize
      const clonedSchema = sanitizeJsonSchemaForOpenAI(rawJsonSchema) as Record<string, unknown>;

      // Create a new inputSchema wrapper that returns our sanitized schema
      const sanitizedInputSchema = {
        ...inputSchemaWrapper,
        // Override the jsonSchema getter with our sanitized version
        get jsonSchema() {
          return clonedSchema;
        },
      };

      // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
      return {
        ...tool,
        inputSchema: sanitizedInputSchema,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as Tool;
    }
  }

  // Fall back to parameters (regular AI SDK tools)
  if (!toolRecord.parameters) {
    return tool;
  }

  // Deep clone and sanitize the parameters to avoid mutating the original
  const clonedParams = sanitizeJsonSchemaForOpenAI(toolRecord.parameters);

  // Create a new tool with sanitized parameters
  // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  return {
    ...tool,
    parameters: clonedParams,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Tool;
}

/**
 * Sanitize all MCP tools for OpenAI compatibility.
 *
 * @param mcpTools - Record of MCP tools to sanitize
 * @returns Record of sanitized tools
 */
export function sanitizeMCPToolsForOpenAI(mcpTools: Record<string, Tool>): Record<string, Tool> {
  const sanitized: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(mcpTools)) {
    sanitized[name] = sanitizeToolSchemaForOpenAI(tool);
  }
  return sanitized;
}
