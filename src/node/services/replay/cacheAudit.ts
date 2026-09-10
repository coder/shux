/**
 * Cache-bust auditor: diffs consecutive turn-envelope rows and attributes
 * prompt-prefix invalidations. Providers cache the request prefix (system
 * prompt + tool definitions + early messages); any change to the system
 * prompt hash, the toolset manifest, the model, the thinking level, or the
 * resolved provider options re-writes that prefix and busts the cache.
 *
 * Token attribution is approximate: where the paired assistant row recorded
 * usage, the busted cost ≈ non-cache-read input (fresh input + cache-write
 * tokens) of the turn that saw the invalidation.
 */

import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import type { TurnEnvelopeEvent } from "./replayVerify";

export interface CacheAuditCause {
  kind: "system-prompt" | "toolset" | "model" | "thinking-level" | "provider-options";
  detail: string;
}

export interface CacheAuditTurn {
  turnIndex: number;
  envelopeSeq: number;
  ts: number;
  modelString: string;
  thinkingLevel: string;
  /** Empty for the baseline first turn and for prefix-stable turns. */
  causes: CacheAuditCause[];
  /** Recorded usage for the paired assistant turn, when available. */
  usage?: ChatUsageDisplay;
  /**
   * Approximate tokens re-processed because of the bust: non-cache-read
   * input (fresh + cache-write) of this turn. Only set when causes exist and
   * usage is available.
   */
  approxBustedTokens?: number;
}

function diffToolsetManifest(
  previous: TurnEnvelopeEvent["data"]["toolsetManifest"],
  current: TurnEnvelopeEvent["data"]["toolsetManifest"]
): string[] {
  const previousByName = new Map(previous.map((entry) => [entry.name, entry.schemaHash]));
  const currentByName = new Map(current.map((entry) => [entry.name, entry.schemaHash]));
  const details: string[] = [];
  for (const [name] of previousByName) {
    if (!currentByName.has(name)) {
      details.push(`removed:${name}`);
    }
  }
  for (const [name, hash] of currentByName) {
    const previousHash = previousByName.get(name);
    if (previousHash === undefined) {
      details.push(`added:${name}`);
    } else if (previousHash !== hash) {
      details.push(`schema-changed:${name}`);
    }
  }
  return details;
}

/**
 * Collapse envelopes to the FINAL row per requestHistorySequence, matching
 * pairSessionTurns: a model-fallback turn emits a superseding envelope for the
 * same sequence, and auditing both would count the turn twice, attach the
 * surviving assistant's usage twice, and report artificial busts between the
 * failed primary and the fallback request. Rows without a sequence (legacy
 * sessions) are kept in place.
 */
export function collapseEnvelopesToFinalPerSequence(
  envelopes: TurnEnvelopeEvent[]
): TurnEnvelopeEvent[] {
  const result: TurnEnvelopeEvent[] = [];
  const indexBySequence = new Map<number, number>();
  for (const envelope of envelopes) {
    const sequence = envelope.data.requestHistorySequence;
    if (sequence == null) {
      result.push(envelope);
      continue;
    }
    const existing = indexBySequence.get(sequence);
    if (existing == null) {
      indexBySequence.set(sequence, result.length);
      result.push(envelope);
    } else {
      result[existing] = envelope;
    }
  }
  return result;
}

/**
 * Attribute prompt-prefix invalidations across consecutive turn envelopes.
 * `usageByTurn` pairs ordinally with `envelopes` (missing/undefined entries
 * simply skip token attribution).
 */
export function auditCacheBusts(
  envelopes: TurnEnvelopeEvent[],
  usageByTurn: Array<ChatUsageDisplay | undefined> = []
): CacheAuditTurn[] {
  return envelopes.map((envelope, index) => {
    const causes: CacheAuditCause[] = [];
    const previous = index > 0 ? envelopes[index - 1] : undefined;

    if (previous) {
      if (previous.data.systemPromptHash !== envelope.data.systemPromptHash) {
        causes.push({
          kind: "system-prompt",
          detail: `${previous.data.systemPromptHash.slice(7, 19)} → ${envelope.data.systemPromptHash.slice(7, 19)}`,
        });
      }
      const toolsetDetails = diffToolsetManifest(
        previous.data.toolsetManifest,
        envelope.data.toolsetManifest
      );
      if (toolsetDetails.length > 0) {
        causes.push({ kind: "toolset", detail: toolsetDetails.join(", ") });
      }
      if (previous.data.modelString !== envelope.data.modelString) {
        causes.push({
          kind: "model",
          detail: `${previous.data.modelString} → ${envelope.data.modelString}`,
        });
      }
      if (previous.data.thinkingLevel !== envelope.data.thinkingLevel) {
        causes.push({
          kind: "thinking-level",
          detail: `${previous.data.thinkingLevel} → ${envelope.data.thinkingLevel}`,
        });
      }
      if (previous.data.providerOptionsHash !== envelope.data.providerOptionsHash) {
        causes.push({
          kind: "provider-options",
          detail: `${previous.data.providerOptionsHash.slice(0, 12)} → ${envelope.data.providerOptionsHash.slice(0, 12)}`,
        });
      }
    }

    const usage = usageByTurn[index];
    const approxBustedTokens =
      causes.length > 0 && usage !== undefined
        ? usage.input.tokens + usage.cacheCreate.tokens
        : undefined;

    return {
      turnIndex: index,
      envelopeSeq: envelope.seq,
      ts: envelope.ts,
      modelString: envelope.data.modelString,
      thinkingLevel: envelope.data.thinkingLevel,
      causes,
      ...(usage !== undefined ? { usage } : {}),
      ...(approxBustedTokens !== undefined ? { approxBustedTokens } : {}),
    };
  });
}
