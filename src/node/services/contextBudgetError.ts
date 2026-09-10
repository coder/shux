import type { ContextBudgetExceeded } from "@/common/utils/compaction/contextBudget";

/** Carries a typed preflight refusal across thinking-rebuild callbacks that cannot return Result. */
export class ContextBudgetExceededError extends Error {
  constructor(readonly details: ContextBudgetExceeded) {
    super(
      `Assembled request for ${details.model} exceeds its context budget (${details.estimate} > ${details.hardCeiling})`
    );
    this.name = "ContextBudgetExceededError";
  }
}

/** A settled hard stop is terminal, not a preflight rejection of the accepted request. */
export class ContextBudgetBlockedError extends Error {
  override name = "ContextBudgetBlockedError";
}
