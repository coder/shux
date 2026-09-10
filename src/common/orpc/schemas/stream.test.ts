import { describe, expect, test } from "bun:test";
import { SendMessageOptionsSchema } from "./stream";

describe("SendMessageOptions experiments", () => {
  test.each([true, false, undefined])(
    "round-trips memoryIntuition override %s without inventing defaults",
    (memoryIntuition) => {
      const parsed = SendMessageOptionsSchema.parse({
        model: "openai:gpt-5.2",
        agentId: "exec",
        experiments: { memoryIntuition },
      });
      expect(parsed.experiments?.memoryIntuition).toBe(memoryIntuition);
    }
  );
  test.each([true, false, undefined])(
    "preserves the continuous compaction override without turning absence into opt-out (%s)",
    (continuousCompaction) => {
      const parsed = SendMessageOptionsSchema.parse({
        model: "anthropic:claude-sonnet-4-5",
        agentId: "exec",
        experiments: continuousCompaction === undefined ? {} : { continuousCompaction },
      });
      expect(parsed.experiments?.continuousCompaction).toBe(continuousCompaction);
    }
  );

  test("rlm round-trips through the send-options schema", () => {
    // Zod strips undeclared keys, so surviving a parse proves the flag is a
    // declared send-options field (not silently dropped en route to backend).
    const parsed = SendMessageOptionsSchema.parse({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
      experiments: { programmaticToolCalling: true, rlm: true, bogus: true },
    });
    expect(parsed.experiments?.rlm).toBe(true);
    expect(parsed.experiments?.programmaticToolCalling).toBe(true);
    expect(parsed.experiments && "bogus" in parsed.experiments).toBe(false);
  });

  test("legacy programmaticToolCallingExclusive payloads parse cleanly and are retained", () => {
    // The exclusive experiment merged into PTC (exclusive-only now). Persisted
    // startup-retry snapshots may still carry the flag; it must parse cleanly
    // and survive round-trips (downgrade-compat mirror), never be rejected.
    const parsed = SendMessageOptionsSchema.parse({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
      experiments: { programmaticToolCalling: true, programmaticToolCallingExclusive: true },
    });
    expect(parsed.experiments?.programmaticToolCalling).toBe(true);
    expect(parsed.experiments?.programmaticToolCallingExclusive).toBe(true);
  });

  test("an exclusive-only legacy snapshot aliases onto merged PTC, winning over explicit false", () => {
    // Old builds could persist { programmaticToolCalling: false,
    // programmaticToolCallingExclusive: true } — that posture is exactly what
    // merged PTC activates, so startup retries must resume with PTC on.
    const parsed = SendMessageOptionsSchema.parse({
      model: "anthropic:claude-sonnet-4-5",
      agentId: "exec",
      experiments: { programmaticToolCalling: false, programmaticToolCallingExclusive: true },
    });
    expect(parsed.experiments?.programmaticToolCalling).toBe(true);
  });
});
