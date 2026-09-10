import { z } from "zod";

// Capture the decision before queue dispatch or removal can change its attribution.
export const StreamStopCauseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("queued-input"),
    entryId: z.string().min(1),
    muxMetadata: z.unknown().optional(),
  }),
  z.object({ kind: z.literal("context-budget"), decision: z.enum(["warn", "rollover", "block"]) }),
  z.object({ kind: z.literal("required-tool") }),
  z.object({ kind: z.literal("step-limit") }),
]);

export type StreamStopCause = z.infer<typeof StreamStopCauseSchema>;
export type QueuedInputStopCause = Extract<StreamStopCause, { kind: "queued-input" }>;
