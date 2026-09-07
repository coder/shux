import { describe, expect, test } from "bun:test";
import { MuxMessageSchema } from "@/common/orpc/schemas/message";
import { createMuxMessage } from "@/common/types/message";
import { hasProviderReplayableContent } from "./providerEligibility";
import {
  createContextBudgetRejectedMessage,
  restoreContextBudgetRejectedMessageForDisplay,
} from "./contextBudgetRejection";

// Model the preceding schema, which drops the fields it cannot interpret.
const legacyMessageSchema = MuxMessageSchema.extend({
  metadata: MuxMessageSchema.shape.metadata
    .unwrap()
    .omit({
      contextBudgetRejected: true,
      contextBudgetRejectedMessage: true,
    })
    .optional(),
});

describe("context-budget rejection capsules", () => {
  test.each(["user", "assistant"] as const)(
    "quarantines %s payloads even for older readers",
    (role) => {
      const original = createMuxMessage("rejected", role, "Private prompt and tool content", {
        historySequence: 7,
        timestamp: 123,
        partial: true,
        synthetic: true,
        uiVisible: true,
        muxMetadata: {
          type: "agent-skill",
          skillName: "test",
          scope: "project",
          rawCommand: "/test",
        },
        agentSkillSnapshot: { skillName: "test", scope: "project", sha256: "test" },
        mcpPromptSnapshot: { serverName: "server", promptName: "prompt", commandKey: "prompt" },
        fileAtMentionSnapshot: ["@private.txt"],
        requestPreludeMessageIds: ["prelude"],
      });
      const capsule = createContextBudgetRejectedMessage(original);
      const persisted = MuxMessageSchema.parse(JSON.parse(JSON.stringify(capsule)));
      expect(persisted).toMatchObject({
        id: original.id,
        role: "assistant",
        parts: [],
        metadata: {
          historySequence: 7,
          timestamp: 123,
          synthetic: true,
          uiVisible: false,
          contextBudgetRejected: true,
        },
      });
      const legacy = legacyMessageSchema.parse(persisted);
      expect(legacy.metadata).toEqual({
        historySequence: 7,
        timestamp: 123,
        synthetic: true,
        uiVisible: false,
      });
      expect(hasProviderReplayableContent(legacy, { preserveReasoningOnly: true })).toBe(false);
      expect(restoreContextBudgetRejectedMessageForDisplay(persisted)).toMatchObject(
        MuxMessageSchema.parse(original)
      );
      expect(createContextBudgetRejectedMessage(persisted)).toEqual(persisted);
    }
  );

  test("legacy flag-only records still display and remain provider-ineligible", () => {
    const legacy = createMuxMessage("old-rejected", "user", "Preserved input", {
      contextBudgetRejected: true,
    });
    expect(restoreContextBudgetRejectedMessageForDisplay(legacy)).toBe(legacy);
    expect(hasProviderReplayableContent(legacy)).toBe(false);
    expect(createContextBudgetRejectedMessage(legacy).parts).toEqual([]);
  });

  test("damaged original display data cannot restore control metadata or fail transcript parsing", () => {
    const capsule = createContextBudgetRejectedMessage(
      createMuxMessage("rejected", "user", "Input")
    );
    const parsed = MuxMessageSchema.parse({
      ...capsule,
      metadata: {
        ...capsule.metadata,
        contextBudgetRejectedMessage: { role: "user", parts: "corrupt" },
      },
    });
    expect(restoreContextBudgetRejectedMessageForDisplay(parsed)).toBe(parsed);
    expect(parsed.parts).toEqual([]);
    expect(hasProviderReplayableContent(parsed)).toBe(false);
  });
});
