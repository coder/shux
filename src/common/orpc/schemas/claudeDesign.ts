import { z } from "zod";

export const ClaudeDesignSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file"), path: z.string().trim().min(1) }),
  z.object({
    type: z.literal("keychain"),
    service: z.string().trim().min(1),
    account: z.string().trim().min(1),
  }),
]);
export const ClaudeDesignSettingsSchema = z.object({
  source: ClaudeDesignSourceSchema.nullable(),
  reuseEnabled: z.boolean(),
  serverEnabled: z.boolean(),
  toolAllowlist: z.array(z.string()).optional(),
});
export const ClaudeDesignStateSchema = z.enum([
  "disabled",
  "not_configured",
  "credentials_unavailable",
  "credentials_invalid",
  "expired",
  "missing_scopes",
  "consent_required",
  "authorization_failed",
  "connection_failed",
  "connected",
]);
export const ClaudeDesignStatusSchema = z.object({
  state: ClaudeDesignStateSchema,
  settings: ClaudeDesignSettingsSchema,
  backendHost: z.string(),
  platform: z.string(),
});
export type ClaudeDesignSource = z.infer<typeof ClaudeDesignSourceSchema>;
export type ClaudeDesignSettings = z.infer<typeof ClaudeDesignSettingsSchema>;
export type ClaudeDesignState = z.infer<typeof ClaudeDesignStateSchema>;
export type ClaudeDesignStatus = z.infer<typeof ClaudeDesignStatusSchema>;
