import { describe, expect, test } from "bun:test";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { auditCacheBusts, collapseEnvelopesToFinalPerSequence } from "./cacheAudit";
import type { TurnEnvelopeEvent } from "./replayVerify";

function makeEnvelope(
  seq: number,
  data: Partial<TurnEnvelopeEvent["data"]> = {}
): TurnEnvelopeEvent {
  return {
    v: 1,
    seq,
    id: `envelope-${seq}`,
    ts: 1_000 + seq,
    workspaceId: "test-ws",
    kind: "turn-envelope",
    data: {
      systemPromptHash: `sha256:${"a".repeat(64)}`,
      toolsetManifest: [{ name: "bash", schemaHash: "hash-1" }],
      modelString: "anthropic:claude-sonnet-4-5",
      providerOptionsHash: "options-1",
      thinkingLevel: "off",
      ...data,
    },
  };
}

function usage(input: number, cacheCreate: number): ChatUsageDisplay {
  return {
    input: { tokens: input },
    cached: { tokens: 0 },
    cacheCreate: { tokens: cacheCreate },
    output: { tokens: 10 },
    reasoning: { tokens: 0 },
  };
}

describe("auditCacheBusts", () => {
  test("first turn is baseline and identical follow-ups report no causes", () => {
    const audit = auditCacheBusts([makeEnvelope(1), makeEnvelope(2)]);
    expect(audit[0].causes).toEqual([]);
    expect(audit[1].causes).toEqual([]);
  });

  test("attributes each changed prefix component", () => {
    const audit = auditCacheBusts([
      makeEnvelope(1),
      makeEnvelope(2, { systemPromptHash: `sha256:${"b".repeat(64)}` }),
      makeEnvelope(3, {
        systemPromptHash: `sha256:${"b".repeat(64)}`,
        modelString: "openai:gpt-5.2",
        thinkingLevel: "high",
        providerOptionsHash: "options-2",
      }),
      makeEnvelope(4, {
        systemPromptHash: `sha256:${"b".repeat(64)}`,
        modelString: "openai:gpt-5.2",
        thinkingLevel: "high",
        providerOptionsHash: "options-2",
        toolsetManifest: [{ name: "bash", schemaHash: "hash-2" }],
      }),
    ]);

    expect(audit[1].causes.map((cause) => cause.kind)).toEqual(["system-prompt"]);
    expect(audit[2].causes.map((cause) => cause.kind).sort()).toEqual([
      "model",
      "provider-options",
      "thinking-level",
    ]);
    expect(audit[3].causes).toEqual([{ kind: "toolset", detail: "schema-changed:bash" }]);
  });

  test("reports tool additions and removals by name", () => {
    const audit = auditCacheBusts([
      makeEnvelope(1, {
        toolsetManifest: [
          { name: "bash", schemaHash: "hash-1" },
          { name: "file_read", schemaHash: "hash-2" },
        ],
      }),
      makeEnvelope(2, {
        toolsetManifest: [
          { name: "bash", schemaHash: "hash-1" },
          { name: "web_search", schemaHash: "hash-3" },
        ],
      }),
    ]);
    expect(audit[1].causes).toEqual([
      { kind: "toolset", detail: "removed:file_read, added:web_search" },
    ]);
  });

  test("attributes busted tokens only when a cause exists and usage is available", () => {
    const audit = auditCacheBusts(
      [
        makeEnvelope(1),
        makeEnvelope(2),
        makeEnvelope(3, { systemPromptHash: `sha256:${"c".repeat(64)}` }),
        makeEnvelope(4, { systemPromptHash: `sha256:${"d".repeat(64)}` }),
      ],
      [usage(1000, 900), usage(50, 0), usage(80, 1200), undefined]
    );

    // Baseline and prefix-stable turns never attribute busted tokens.
    expect(audit[0].approxBustedTokens).toBeUndefined();
    expect(audit[1].approxBustedTokens).toBeUndefined();
    // Busted turn: fresh input + cache-write tokens.
    expect(audit[2].approxBustedTokens).toBe(1280);
    // Busted turn without recorded usage: cause reported, tokens unknown.
    expect(audit[3].causes.map((cause) => cause.kind)).toEqual(["system-prompt"]);
    expect(audit[3].approxBustedTokens).toBeUndefined();
  });
});

describe("collapseEnvelopesToFinalPerSequence", () => {
  test("fallback turns audit once with the identity that actually streamed", () => {
    const primary = makeEnvelope(0, {
      requestHistorySequence: 5,
      modelString: "anthropic:claude-primary",
    });
    const fallback = makeEnvelope(1, {
      requestHistorySequence: 5,
      modelString: "openai:gpt-fallback",
    });
    const nextTurn = makeEnvelope(2, {
      requestHistorySequence: 7,
      modelString: "openai:gpt-fallback",
    });

    const collapsed = collapseEnvelopesToFinalPerSequence([primary, fallback, nextTurn]);
    expect(collapsed).toEqual([fallback, nextTurn]);

    // The superseded primary is invisible to the audit: no artificial model
    // bust between the failed primary and the fallback request.
    const audit = auditCacheBusts(collapsed);
    expect(audit).toHaveLength(2);
    expect(audit[1].causes).toEqual([]);
  });

  test("legacy rows without a sequence are kept in order", () => {
    const legacyA = makeEnvelope(0);
    const keyed = makeEnvelope(1, { requestHistorySequence: 3 });
    const legacyB = makeEnvelope(2);
    expect(collapseEnvelopesToFinalPerSequence([legacyA, keyed, legacyB])).toEqual([
      legacyA,
      keyed,
      legacyB,
    ]);
  });
});
