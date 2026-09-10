import { z } from "zod";

/**
 * Generic Result schema for success/failure discriminated unions
 */
export const ResultSchema = <T extends z.ZodTypeAny, E extends z.ZodTypeAny = z.ZodString>(
  dataSchema: T,
  // eslint-disable-next-line local/no-chained-type-assertions -- grandfathered when the rule was introduced; fix the underlying type instead of copying this pattern
  errorSchema: E = z.string() as unknown as E
) =>
  z.discriminatedUnion("success", [
    z.object({ success: z.literal(true), data: dataSchema }),
    z.object({ success: z.literal(false), error: errorSchema }),
  ]);
