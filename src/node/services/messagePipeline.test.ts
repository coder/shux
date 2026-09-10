import { describe, expect, it } from "bun:test";
import type { AssistantModelMessage, ModelMessage } from "ai";

import { transformModelMessages } from "@/browser/utils/messages/modelMessageTransform";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { ThinkingLevel } from "@/common/types/thinking";
import { createTestHistoryService } from "./testHistoryService";
import { prepareMessagesForProvider, sanitizeAssistantModelMessages } from "./messagePipeline";

function isAssistantMessage(message: ModelMessage | undefined): message is AssistantModelMessage {
  return message?.role === "assistant";
}

describe("sanitizeAssistantModelMessages", () => {
  it("preserves whitespace-only separators before later text coalescing", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "## Verdict" },
          { type: "text", text: "\n\n" },
          { type: "text", text: "This is now **strong evidence**." },
        ],
      },
    ];

    const sanitized = sanitizeAssistantModelMessages(messages);
    const transformed = transformModelMessages(sanitized, "openai");

    expect(isAssistantMessage(sanitized[0])).toBe(true);
    if (isAssistantMessage(sanitized[0])) {
      expect(sanitized[0].content).toEqual([
        { type: "text", text: "## Verdict\n\nThis is now **strong evidence**." },
      ]);
    }

    expect(isAssistantMessage(transformed[0])).toBe(true);
    if (isAssistantMessage(transformed[0])) {
      expect(transformed[0].content).toEqual([
        { type: "text", text: "## Verdict\n\nThis is now **strong evidence**." },
      ]);
    }
  });

  it("still filters assistant messages that contain only whitespace text", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "\n" },
          { type: "text", text: "\t " },
        ],
      },
    ];

    expect(sanitizeAssistantModelMessages(messages)).toEqual([]);
  });
});

describe("prepareMessagesForProvider log purity", () => {
  const baseOptions = {
    effectiveAgentId: "exec",
    toolNamesForSentinel: [] as string[],
    providerForMessages: "anthropic",
    effectiveThinkingLevel: "off" as const,
    modelString: "anthropic:claude-sonnet-4-5",
    workspaceId: "test-ws",
  };

  it("rebuilds identical provider messages from the same history rows", async () => {
    // Snapshot + file-change rows are durable history entries; the pipeline must
    // derive the request from them alone (no live disk reads or tracker state),
    // so building twice from the same log yields byte-identical messages.
    const messages = [
      createMuxMessage(
        "file-snapshot-1",
        "user",
        '<mux-file path="src/foo.ts" range="L1-L2">\n```ts\nline1\nline2\n```\n</mux-file>',
        { timestamp: 1000, synthetic: true, fileAtMentionSnapshot: ["src/foo.ts"] }
      ),
      createMuxMessage("user-1", "user", "Please check @src/foo.ts", { timestamp: 1001 }),
      createMuxMessage("assistant-1", "assistant", "Looks fine.", { timestamp: 1002 }),
      createMuxMessage(
        "file-change-1",
        "user",
        "<system-file-update>\nNote: src/foo.ts was modified.\n</system-file-update>",
        { timestamp: 1003, synthetic: true }
      ),
      createMuxMessage("user-2", "user", "Continue", { timestamp: 1004 }),
    ];

    const first = await prepareMessagesForProvider({
      ...baseOptions,
      messagesWithSentinel: messages,
    });
    const second = await prepareMessagesForProvider({
      ...baseOptions,
      messagesWithSentinel: messages,
    });

    expect(second).toEqual(first);

    // The model-visible file content comes from the log rows themselves.
    const serialized = JSON.stringify(first);
    expect(serialized).toContain("<mux-file");
    expect(serialized).toContain("<system-file-update>");
  });

  it("builds old-format histories with un-materialized @mentions as plain text", async () => {
    // Histories written before send-time @mention materialization contain no
    // snapshot rows. There is no request-time fallback that reads live disk, so
    // the mention stays plain text — and the request still builds without error.
    const messages = [
      createMuxMessage("user-1", "user", "Please check @src/foo.ts", { timestamp: 1000 }),
      createMuxMessage("assistant-1", "assistant", "Sure.", { timestamp: 1001 }),
      createMuxMessage("user-2", "user", "Continue", { timestamp: 1002 }),
    ];

    const result = await prepareMessagesForProvider({
      ...baseOptions,
      messagesWithSentinel: messages,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).toContain("@src/foo.ts");
    expect(serialized).not.toContain("<mux-file");
  });
});

describe("reasoning replay in built provider requests", () => {
  function historyWith(assistantParts: MuxMessage["parts"]): MuxMessage[] {
    return [
      createMuxMessage("user-1", "user", "solve it", { timestamp: 1000 }),
      {
        id: "assistant-1",
        role: "assistant",
        metadata: { timestamp: 1001 },
        parts: assistantParts,
      },
      createMuxMessage("user-2", "user", "continue", { timestamp: 1002 }),
    ];
  }

  function buildRequest(
    provider: string,
    thinkingLevel: ThinkingLevel,
    messages: MuxMessage[]
  ): Promise<ModelMessage[]> {
    return prepareMessagesForProvider({
      messagesWithSentinel: messages,
      effectiveAgentId: "exec",
      toolNamesForSentinel: [],
      providerForMessages: provider,
      effectiveThinkingLevel: thinkingLevel,
      modelString: `${provider}:model`,
      workspaceId: "test-ws",
    });
  }

  type ReasoningRequestPart = Extract<
    Exclude<AssistantModelMessage["content"], string>[number],
    { type: "reasoning" }
  >;

  function reasoningRequestParts(messages: ModelMessage[]): ReasoningRequestPart[] {
    return messages
      .filter(isAssistantMessage)
      .flatMap((msg) => (Array.isArray(msg.content) ? msg.content : []))
      .filter((part): part is ReasoningRequestPart => part.type === "reasoning");
  }

  it("includes signed Anthropic reasoning with its signature when thinking is enabled", async () => {
    const result = await buildRequest(
      "anthropic",
      "medium",
      historyWith([
        {
          type: "reasoning",
          text: "let me think",
          providerOptions: { anthropic: { signature: "sig_live" } },
        },
        { type: "text", text: "answer" },
      ])
    );

    expect(reasoningRequestParts(result)).toEqual([
      {
        type: "reasoning",
        text: "let me think",
        providerOptions: { anthropic: { signature: "sig_live" } },
      },
    ]);
  });

  it("omits unsigned Anthropic reasoning when thinking is enabled", async () => {
    const result = await buildRequest(
      "anthropic",
      "medium",
      historyWith([
        { type: "reasoning", text: "secret thoughts" },
        { type: "text", text: "answer" },
      ])
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret thoughts");
    expect(serialized).not.toContain("signature");
  });

  it("omits reasoning-only assistant messages when Anthropic thinking is off", async () => {
    const result = await buildRequest(
      "anthropic",
      "off",
      historyWith([
        {
          type: "reasoning",
          text: "orphan thoughts",
          providerOptions: { anthropic: { signature: "sig_live" } },
        },
      ])
    );

    expect(result.some((msg) => msg.role === "assistant")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("orphan thoughts");
  });

  it("includes OpenAI reasoning itemId and encrypted content", async () => {
    const result = await buildRequest(
      "openai",
      "high",
      historyWith([
        {
          type: "reasoning",
          text: "redacted summary",
          providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc_blob" } },
        },
        { type: "text", text: "answer" },
      ])
    );

    expect(reasoningRequestParts(result)).toEqual([
      {
        type: "reasoning",
        text: "redacted summary",
        providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc_blob" } },
      },
    ]);
  });

  it("includes xAI reasoning itemId and encrypted content", async () => {
    const result = await buildRequest(
      "xai",
      "high",
      historyWith([
        {
          type: "reasoning",
          text: "grok thoughts",
          providerOptions: { xai: { itemId: "rs_x", reasoningEncryptedContent: "enc_x" } },
        },
        { type: "text", text: "answer" },
      ])
    );

    expect(reasoningRequestParts(result)).toEqual([
      {
        type: "reasoning",
        text: "grok thoughts",
        providerOptions: { xai: { itemId: "rs_x", reasoningEncryptedContent: "enc_x" } },
      },
    ]);
  });

  it("omits a bare xAI itemId from an interrupted stream (store=false, unresolvable)", async () => {
    const result = await buildRequest(
      "xai",
      "high",
      historyWith([
        {
          type: "reasoning",
          text: "interrupted thoughts",
          providerOptions: { xai: { itemId: "rs_partial" } },
        },
        { type: "text", text: "answer" },
      ])
    );

    expect(JSON.stringify(result)).not.toContain("rs_partial");
  });

  it("omits a bare OpenAI itemId from an interrupted stream (ZDR, unresolvable)", async () => {
    const result = await buildRequest(
      "openai",
      "high",
      historyWith([
        {
          type: "reasoning",
          text: "interrupted thoughts",
          providerOptions: { openai: { itemId: "rs_partial" } },
        },
        { type: "text", text: "answer" },
      ])
    );

    expect(JSON.stringify(result)).not.toContain("rs_partial");
  });

  it("bridges legacy signature-only histories to a replayable Anthropic signature", async () => {
    const result = await buildRequest(
      "anthropic",
      "medium",
      historyWith([
        { type: "reasoning", text: "old style", signature: "legacy_sig" },
        { type: "text", text: "answer" },
      ])
    );

    expect(reasoningRequestParts(result)).toEqual([
      {
        type: "reasoning",
        text: "old style",
        providerOptions: { anthropic: { signature: "legacy_sig" } },
      },
    ]);
  });

  it("keeps the Anthropic signature from the last part when coalescing a streamed run", async () => {
    const result = await buildRequest(
      "anthropic",
      "medium",
      historyWith([
        { type: "reasoning", text: "I " },
        { type: "reasoning", text: "see " },
        { type: "reasoning", text: "it", providerOptions: { anthropic: { signature: "sig_end" } } },
        { type: "text", text: "answer" },
      ])
    );

    expect(reasoningRequestParts(result)).toEqual([
      {
        type: "reasoning",
        text: "I see it",
        providerOptions: { anthropic: { signature: "sig_end" } },
      },
    ]);
  });

  it("merges later partial options without clobbering encrypted content when coalescing", async () => {
    // ZDR shape: first part of the run carries itemId + encrypted content
    // (attached at reasoning-end), a later delta repeats only the itemId.
    // Coalescing must merge namespaces, not replace the accumulated object.
    const result = await buildRequest(
      "openai",
      "high",
      historyWith([
        {
          type: "reasoning",
          text: "a",
          providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
        },
        { type: "reasoning", text: "b", providerOptions: { openai: { itemId: "rs_1" } } },
        { type: "text", text: "answer" },
      ])
    );

    expect(reasoningRequestParts(result)).toEqual([
      {
        type: "reasoning",
        text: "ab",
        providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
      },
    ]);
  });

  it("keeps a malformed history row from poisoning the built request", async () => {
    // Self-healing doctrine: corrupt replay metadata in chat.jsonl must degrade
    // to plain reasoning handling, not forward junk the provider rejects.
    const result = await buildRequest(
      "openai",
      "high",
      historyWith([
        {
          type: "reasoning",
          text: "corrupt metadata",
          signature: 999,
          providerOptions: { openai: { itemId: 42 } },
        } as unknown as MuxMessage["parts"][number],
        { type: "text", text: "answer" },
      ])
    );

    const assistant = result.filter(isAssistantMessage);
    expect(assistant.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('"itemId":42');
    expect(JSON.stringify(result)).not.toContain("999");
  });

  it("keeps OpenAI options from the first part when coalescing a streamed run", async () => {
    const result = await buildRequest(
      "openai",
      "high",
      historyWith([
        {
          type: "reasoning",
          text: "a",
          providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
        },
        { type: "reasoning", text: "b" },
        { type: "reasoning", text: "c" },
        { type: "text", text: "answer" },
      ])
    );

    expect(reasoningRequestParts(result)).toEqual([
      {
        type: "reasoning",
        text: "abc",
        providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
      },
    ]);
  });

  it("replays reasoning persisted by a prior turn when building the next request", async () => {
    // The issue #11 scenario: a new sendMessage on an existing workspace must
    // rebuild prior-turn reasoning from disk, so exercise the real history
    // read/write path instead of in-memory fixtures.
    const { historyService, cleanup } = await createTestHistoryService();
    try {
      const workspaceId = "reasoning-replay-ws";
      const turns = [
        createMuxMessage("user-1", "user", "solve it", { timestamp: 1000 }),
        {
          id: "assistant-1",
          role: "assistant",
          metadata: { timestamp: 1001 },
          parts: [
            {
              type: "reasoning",
              text: "persisted thinking",
              signature: "sig_disk",
              providerOptions: { anthropic: { signature: "sig_disk" } },
            },
            { type: "text", text: "the answer" },
          ],
        } satisfies MuxMessage,
        createMuxMessage("user-2", "user", "next question", { timestamp: 1002 }),
      ];
      for (const message of turns) {
        const appendResult = await historyService.appendToHistory(workspaceId, message);
        expect(appendResult.success).toBe(true);
      }

      const historyResult = await historyService.getHistoryFromLatestBoundary(workspaceId);
      if (!historyResult.success) {
        throw new Error(historyResult.error);
      }

      const result = await buildRequest("anthropic", "medium", historyResult.data);

      expect(reasoningRequestParts(result)).toEqual([
        {
          type: "reasoning",
          text: "persisted thinking",
          providerOptions: { anthropic: { signature: "sig_disk" } },
        },
      ]);
    } finally {
      await cleanup();
    }
  });
});
