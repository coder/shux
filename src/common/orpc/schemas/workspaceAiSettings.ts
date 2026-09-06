import { z } from "zod";
import { OpenAIReasoningModeSchema, ThinkingLevelSchema } from "../../types/thinking";

/**
 * Workspace-scoped AI settings that should persist across devices.
 *
 * Notes:
 * - `model` must be canonical "provider:model" (NOT mux-gateway:provider/model).
 * - `thinkingLevel` is workspace-scoped (saved per workspace, not per-model).
 */

export const WorkspaceAISettingsSchema = z.object({
  model: z.string().meta({ description: 'Canonical model id in the form "provider:model"' }),
  thinkingLevel: ThinkingLevelSchema.meta({
    description: "Thinking/reasoning effort level",
  }),
  // Optional so legacy persisted settings without the field parse unchanged.
  reasoningMode: OpenAIReasoningModeSchema.optional().meta({
    description:
      'OpenAI reasoning mode (orthogonal to effort). Applies to supported models on direct OpenAI Responses API routes; inert elsewhere. Absent = "standard".',
  }),
});

/**
 * Per-agent workspace AI overrides.
 *
 * Notes:
 * - Keys are agent IDs (plan/exec/custom), values are model + thinking overrides.
 */
export const WorkspaceAISettingsByAgentSchema = z.record(
  z.string().min(1),
  WorkspaceAISettingsSchema
);
