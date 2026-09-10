import { describe, expect, test } from "bun:test";
import { MuxMessageSchema } from "./message";

function createMessage() {
  return {
    id: "msg-1",
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: "Hello" }],
  };
}

describe("MuxMessageSchema mcpPromptSnapshot parsing", () => {
  test("strips malformed snapshot metadata instead of failing the history parse", () => {
    const malformedSnapshotValues: unknown[] = [null, {}, { serverName: 42 }, "snapshot", []];

    for (const malformed of malformedSnapshotValues) {
      const parsed = MuxMessageSchema.parse({
        ...createMessage(),
        role: "user" as const,
        metadata: {
          synthetic: true,
          mcpPromptSnapshot: malformed,
          agentSkillSnapshot: malformed,
        },
      });

      expect(parsed.metadata?.mcpPromptSnapshot).toBeUndefined();
      expect(parsed.metadata?.agentSkillSnapshot).toBeUndefined();
    }
  });

  test("preserves invokingMessageId across boundary parsing", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      role: "user" as const,
      metadata: {
        synthetic: true,
        mcpPromptSnapshot: {
          serverName: "coder",
          promptName: "review",
          commandKey: "mcp__coder__review",
          invokingMessageId: "user-1",
        },
      },
    });

    expect(parsed.metadata?.mcpPromptSnapshot?.invokingMessageId).toBe("user-1");
  });
});

describe("MuxMessageSchema step boundaries", () => {
  test("preserves step indices and continuous summary metadata across replay", () => {
    const metadata = {
      stepStartPartIndices: [0, 2, 5],
      muxMetadata: { type: "compaction-summary", strategy: "continuous" },
    };
    const parsed = MuxMessageSchema.parse({ ...createMessage(), metadata });
    expect(parsed.metadata?.stepStartPartIndices).toEqual(metadata.stepStartPartIndices);
    expect(parsed.metadata?.muxMetadata).toEqual(metadata.muxMetadata);
  });

  test("ignores malformed step metadata rather than failing chat replay", () => {
    for (const stepStartPartIndices of [null, "0,2", [0, "2"], {}]) {
      const parsed = MuxMessageSchema.parse({
        ...createMessage(),
        metadata: { stepStartPartIndices },
      });
      expect(parsed.metadata?.stepStartPartIndices).toBeUndefined();
      expect(parsed.parts).toEqual(createMessage().parts);
    }
  });
});

describe("MuxMessageSchema compactionEpoch parsing", () => {
  test("preserves valid positive integer compactionEpoch", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: {
        compactionEpoch: 7,
      },
    });

    expect(parsed.metadata?.compactionEpoch).toBe(7);
  });

  test("preserves acpPromptId metadata", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: {
        acpPromptId: "acp-prompt-123",
      },
    });

    expect(parsed.metadata?.acpPromptId).toBe("acp-prompt-123");
  });

  test("preserves routeProvider metadata", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: {
        routeProvider: "openai",
      },
    });

    expect(parsed.metadata?.routeProvider).toBe("openai");
  });

  test("preserves modelFallback metadata", () => {
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: {
        modelFallback: {
          requestedModel: "openai:gpt-5.5",
          refusedModels: ["openai:gpt-5.5", "google:gemini-3.1-pro-preview"],
        },
      },
    });

    expect(parsed.metadata?.modelFallback).toEqual({
      requestedModel: "openai:gpt-5.5",
      refusedModels: ["openai:gpt-5.5", "google:gemini-3.1-pro-preview"],
    });
  });

  test("preserves unknown muxMetadata as an opaque value", () => {
    const legacyMetadata = {
      type: "removed-feature",
      rawCommand: "/removed legacy command",
      nested: { version: 1 },
    };
    const parsed = MuxMessageSchema.parse({
      ...createMessage(),
      metadata: { muxMetadata: legacyMetadata },
    });

    expect(parsed.metadata?.muxMetadata).toEqual(legacyMetadata);
  });

  test("tolerates malformed modelFallback values by treating them as absent", () => {
    const malformedModelFallbackValues: unknown[] = [
      null,
      "openai:gpt-5.5",
      7,
      [],
      {},
      { requestedModel: "openai:gpt-5.5" }, // missing refusedModels
      { refusedModels: ["openai:gpt-5.5"] }, // missing requestedModel
      { requestedModel: "openai:gpt-5.5", refusedModels: [7] }, // wrong element type
      { requestedModel: 7, refusedModels: ["openai:gpt-5.5"] },
    ];

    for (const malformedModelFallback of malformedModelFallbackValues) {
      const parsed = MuxMessageSchema.parse({
        ...createMessage(),
        metadata: {
          modelFallback: malformedModelFallback,
        },
      });

      expect(parsed.metadata?.modelFallback).toBeUndefined();
    }
  });

  test("tolerates malformed compactionEpoch values by treating them as absent", () => {
    const malformedCompactionEpochValues: unknown[] = [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "7",
      null,
      true,
      {},
      [],
    ];

    for (const malformedCompactionEpoch of malformedCompactionEpochValues) {
      const parsed = MuxMessageSchema.parse({
        ...createMessage(),
        metadata: {
          compactionEpoch: malformedCompactionEpoch,
        },
      });

      expect(parsed.metadata?.compactionEpoch).toBeUndefined();
    }
  });
});
