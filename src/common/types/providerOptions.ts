import type z from "zod";
import type { MuxProviderOptionsSchema } from "../orpc/schemas";

/**
 * Xum provider-specific options that get passed through the stack.
 * Used by both frontend and backend to configure provider-specific features
 * without polluting function signatures with individual flags.
 *
 * Note: This is separate from the AI SDK's provider options
 * (src/utils/ai/providerOptions.ts) which configures thinking levels, etc.
 * These options configure features that need to be applied at the provider
 * configuration level (e.g., custom headers, beta features).
 */

export type MuxProviderOptions = z.infer<typeof MuxProviderOptionsSchema>;

/** OpenAI wire format selected in provider settings or per request. */
export type OpenAIWireFormat = NonNullable<NonNullable<MuxProviderOptions["openai"]>["wireFormat"]>;
