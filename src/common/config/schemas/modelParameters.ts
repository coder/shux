import type { CallSettings } from "ai";
import { z } from "zod";

const STANDARD_MODEL_PARAMETER_SHAPE = {
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().positive().optional(),
  seed: z.number().int().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
} as const;

export const StandardModelParameterOverridesSchema = z.object(STANDARD_MODEL_PARAMETER_SHAPE);

// Single runtime mapping source of truth (snake_case config -> AI SDK CallSettings keys)
export const STANDARD_MODEL_PARAMETER_TO_CALL_SETTING = {
  max_output_tokens: "maxOutputTokens",
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK",
  seed: "seed",
  frequency_penalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
} as const satisfies Record<keyof typeof STANDARD_MODEL_PARAMETER_SHAPE, keyof CallSettings>;

export const ModelParameterOverridesSchema = StandardModelParameterOverridesSchema.passthrough();

export const ModelParametersByModelSchema = z.record(
  z.string().min(1),
  ModelParameterOverridesSchema
);

// Downstream type for call settings forwarding — derived from AI SDK CallSettings
export type ResolvedCallSettingsOverrides = Partial<
  Pick<
    CallSettings,
    (typeof STANDARD_MODEL_PARAMETER_TO_CALL_SETTING)[keyof typeof STANDARD_MODEL_PARAMETER_TO_CALL_SETTING]
  >
>;
