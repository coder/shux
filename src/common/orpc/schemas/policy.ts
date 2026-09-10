import { z } from "zod";
import {
  isBuiltInProvider,
  isValidCustomProviderId,
} from "@/common/utils/providers/customProviders";

export const PolicyFormatVersionSchema = z.literal("0.1");

export const PolicyProviderIdSchema = z
  .string()
  .refine((id) => isBuiltInProvider(id) || isValidCustomProviderId(id), {
    message: "Invalid provider id",
  });

export const PolicyProviderNameSchema = PolicyProviderIdSchema;

export const PolicyProviderAccessSchema = z
  .object({
    id: PolicyProviderNameSchema,
    // Empty/undefined means "do not force".
    base_url: z.string().optional(),
    // Empty/undefined means "allow all".
    model_access: z.array(z.string()).optional(),
  })
  .strict();

export const PolicyAllowUserDefinedMCPSchema = z
  .object({
    stdio: z.boolean(),
    remote: z.boolean(),
  })
  .strict();

export const PolicyToolsSchema = z
  .object({
    allow_user_defined_mcp: PolicyAllowUserDefinedMCPSchema.optional(),
  })
  .strict();

export const PolicyRuntimeIdSchema = z.enum([
  "local",
  "worktree",
  "ssh",
  "ssh+coder",
  "docker",
  "devcontainer",
]);
export type PolicyRuntimeId = z.infer<typeof PolicyRuntimeIdSchema>;

export const PolicyRuntimeAccessSchema = z
  .object({
    id: PolicyRuntimeIdSchema,
  })
  .strict();

export const PolicyFileSchema = z
  .object({
    policy_format_version: PolicyFormatVersionSchema,
    server_version: z.string().optional(),
    minimum_client_version: z.string().optional(),

    // Empty/undefined means "allow all".
    provider_access: z.array(PolicyProviderAccessSchema).optional(),

    tools: PolicyToolsSchema.optional(),

    // Empty/undefined means "allow all".
    runtimes: z.array(PolicyRuntimeAccessSchema).optional(),
  })
  .strict();

export const PolicyStatusSchema = z
  .object({
    state: z.enum(["disabled", "enforced", "blocked"]),
    reason: z.string().optional(),
  })
  .strict();
export type PolicyStatus = z.infer<typeof PolicyStatusSchema>;

export const PolicySourceSchema = z.enum(["none", "env", "governor"]);
export type PolicySource = z.infer<typeof PolicySourceSchema>;

export const EffectivePolicyProviderAccessSchema = z
  .object({
    id: PolicyProviderNameSchema,
    forcedBaseUrl: z.string().optional(),
    // null means "allow all" for that provider.
    allowedModels: z.array(z.string()).nullable().optional(),
  })
  .strict();

export const EffectivePolicySchema = z
  .object({
    policyFormatVersion: PolicyFormatVersionSchema,
    serverVersion: z.string().optional(),
    minimumClientVersion: z.string().optional(),

    // null means "allow all providers".
    providerAccess: z.array(EffectivePolicyProviderAccessSchema).nullable(),

    mcp: z
      .object({
        allowUserDefined: z.object({ stdio: z.boolean(), remote: z.boolean() }).strict(),
      })
      .strict(),

    // null means "allow all runtimes".
    runtimes: z.array(PolicyRuntimeIdSchema).nullable(),
  })
  .strict();
export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>;

export const PolicyGetResponseSchema = z
  .object({
    source: PolicySourceSchema,
    status: PolicyStatusSchema,
    policy: EffectivePolicySchema.nullable(),
  })
  .strict();
export type PolicyGetResponse = z.infer<typeof PolicyGetResponseSchema>;
