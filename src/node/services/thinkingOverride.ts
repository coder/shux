/**
 * Mid-turn thinking-level override state.
 *
 * One holder object is created per turn by AgentSession (at durable turn
 * acceptance) and threaded BY REFERENCE down through AIService into
 * StreamManager's request config — the same shared-mutable-state pattern as
 * ToolSearchStreamState. The renderer's thinking slider writes `pending` via
 * AgentSession.setActiveTurnThinkingLevel; StreamManager consumes it at the
 * next prepareStep (which runs before every model step, including step 1, so
 * changes during the PREPARING window apply to the turn's first request).
 *
 * Node-runtime-local: carries a callback, so it does not belong in
 * src/common/types (never crosses IPC).
 */
import type { ModelMessage } from "ai";
import type { ThinkingLevel } from "@/common/types/thinking";

export interface ActiveTurnThinkingOverride {
  /** Raw level requested mid-turn; consumed at the next prepareStep (incl. step 1). */
  pending?: ThinkingLevel;
  /** Effective level after the most recent successful application. */
  applied?: ThinkingLevel;
  /** Sink wired by StreamManager to the owning streamInfo (metadata). */
  onApplied?: (level: ThinkingLevel) => void;
}

/**
 * Result of rebuilding provider options for a mid-turn thinking-level change.
 * `null` from the rebuild closure means "not applicable / no-op" (e.g. the
 * clamped level equals the current one, or the transition would require a
 * different model instance) — the pending override is then dropped for this
 * turn and the persisted setting still covers the next turn.
 */
export interface RebuiltThinkingProviderOptions {
  effectiveLevel: ThinkingLevel;
  providerOptions: Record<string, unknown>;
}

export type RebuildProviderOptionsForThinkingLevel = (
  level: ThinkingLevel
) => RebuiltThinkingProviderOptions | null;

/**
 * Step-0 message rebuild for a thinking override consumed after stream
 * construction (a slider write can race startStream's awaits, landing after
 * the pre-construction quiescence fold). Message preparation is
 * thinking-level-dependent, so an options-only rebuild would send messages
 * transformed for the wrong mode. Returns the fully prepared first-step
 * messages; implementations also emit a superseding turn envelope so replay
 * matches the wire request.
 */
export type RebuildFirstStepForThinkingLevel = (
  effectiveLevel: ThinkingLevel,
  providerOptions: Record<string, unknown>
) => Promise<ModelMessage[]>;
