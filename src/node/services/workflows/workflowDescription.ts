/**
 * Shared parser for workflow `export const meta = { description: "..." }` declarations.
 *
 * Workflow display helpers consume this so the description convention cannot drift.
 * Metadata is parsed
 * statically rather than evaluated: discovery must not run arbitrary top-level
 * workflow code just to read a description.
 */

import { parseStaticWorkflowMetadataLiteral } from "./staticWorkflowMetadata";

export function parseWorkflowDescription(source: string): string | null {
  try {
    return parseWorkflowMetadataDescription(parseStaticWorkflowMetadataLiteral(source));
  } catch {
    return null;
  }
}

export function parseWorkflowName(source: string): string | null {
  try {
    return parseWorkflowMetadataName(parseStaticWorkflowMetadataLiteral(source));
  } catch {
    return null;
  }
}

export function parseWorkflowMetadataName(rawMetadata: unknown): string | null {
  return readWorkflowMetadataString(rawMetadata, "name");
}

export function parseWorkflowMetadataDescription(rawMetadata: unknown): string | null {
  return readWorkflowMetadataString(rawMetadata, "description");
}

// `name` and `description` are both optional string fields read off the same
// untrusted, statically-parsed metadata object; share the object guard and
// trim/normalize so the two accessors cannot drift on how a property is validated.
function readWorkflowMetadataString(
  rawMetadata: unknown,
  key: "name" | "description"
): string | null {
  if (rawMetadata != null && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)) {
    return normalizeDescription((rawMetadata as Record<string, unknown>)[key]);
  }
  return null;
}

function normalizeDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
