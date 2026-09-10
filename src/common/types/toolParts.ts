/**
 * Type definitions for dynamic tool parts
 */

import type { z } from "zod";
import type { DynamicToolPartPendingSchema, DynamicToolPartSchema } from "../orpc/schemas";
export type DynamicToolPartPending = z.infer<typeof DynamicToolPartPendingSchema>;
export type DynamicToolPart = z.infer<typeof DynamicToolPartSchema>;

export function isDynamicToolPart(part: unknown): part is DynamicToolPart {
  return (
    typeof part === "object" && part !== null && "type" in part && part.type === "dynamic-tool"
  );
}
