import { z } from "zod";

const HostKeyPromptRequestSchemaBase = z
  .object({
    requestId: z.string(),
    host: z.string(),
    keyType: z.string(),
    fingerprint: z.string(),
    prompt: z.string(),
  })
  .strict();

const SshHostKeyPromptRequestSchema = HostKeyPromptRequestSchemaBase.extend({
  kind: z.literal("host-key"),
}).strict();

const SshCredentialPromptRequestSchema = z
  .object({
    requestId: z.string(),
    kind: z.literal("credential"),
    prompt: z.string(),
    secret: z.boolean(),
  })
  .strict();

export const SshPromptRequestSchema = z.discriminatedUnion("kind", [
  SshHostKeyPromptRequestSchema,
  SshCredentialPromptRequestSchema,
]);

export type SshPromptRequest = z.infer<typeof SshPromptRequestSchema>;
export type SshHostKeyPromptRequest = z.infer<typeof SshHostKeyPromptRequestSchema>;
export type SshCredentialPromptRequest = z.infer<typeof SshCredentialPromptRequestSchema>;

const SshPromptRequestEventSchema = z.discriminatedUnion("kind", [
  SshHostKeyPromptRequestSchema.extend({ type: z.literal("request") }).strict(),
  SshCredentialPromptRequestSchema.extend({ type: z.literal("request") }).strict(),
]);

export const SshPromptEventSchema = z.union([
  SshPromptRequestEventSchema,
  z
    .object({
      type: z.literal("removed"),
      requestId: z.string(),
    })
    .strict(),
]);

export type SshPromptEvent = z.infer<typeof SshPromptEventSchema>;

export const SshPromptResponseInputSchema = z
  .object({
    requestId: z.string(),
    response: z.string(),
  })
  .strict();
