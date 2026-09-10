import { z } from "zod";

/**
 * A secret value can be a literal string or an alias to another secret key.
 */
export const SecretValueSchema = z.union([
  z.string(),
  z
    .object({
      secret: z.string(),
    })
    .strict(),
]);

export const SecretSchema = z
  .object({
    key: z.string(),
    value: SecretValueSchema,
    injectAll: z.boolean().optional(),
  })
  .meta({
    description: "A key-value pair for storing sensitive configuration",
  });
