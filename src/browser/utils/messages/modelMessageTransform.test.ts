import { describe, it, expect } from "@jest/globals";
import type { ModelMessage, AssistantModelMessage, ToolModelMessage } from "ai";
import {
  transformModelMessages,
  validateAnthropicCompliance,
  getAnthropicThinkingDisableReason,
  addInterruptedSentinel,
  injectAgentTransition,
  filterEmptyAssistantMessages,
  injectPostCompactionAttachments,
  stripOrphanedToolCalls,
} from "./modelMessageTransform";
import { MAX_POST_COMPACTION_INJECTION_CHARS } from "@/common/constants/attachments";
import type { MuxMessage } from "@/common/types/message";

describe("modelMessageTransform", () => {
  describe("transformModelMessages", () => {
    it("should handle assistant messages with string content", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: "Hi there!",
      };

      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
        assistantMsg,
      ];

      const result = transformModelMessages(messages, "anthropic");
      expect(result).toEqual(messages);
    });

    it("should split mixed text and tool-call content into ordered segments", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "Before" },
          { type: "tool-call", toolCallId: "call1", toolName: "bash", input: { script: "pwd" } },
          { type: "text", text: "After" },
        ],
      };
      const toolMsg: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: { stdout: "/home/user" } },
          },
        ],
      };

      const result = transformModelMessages([assistantMsg, toolMsg], "anthropic");

      expect(result).toHaveLength(3);
      expect(result[0].role).toBe("assistant");
      expect((result[0] as AssistantModelMessage).content).toEqual([
        { type: "text", text: "Before" },
        { type: "tool-call", toolCallId: "call1", toolName: "bash", input: { script: "pwd" } },
      ]);
      expect(result[1].role).toBe("tool");
      expect((result[1] as ToolModelMessage).content[0]).toEqual({
        type: "tool-result",
        toolCallId: "call1",
        toolName: "bash",
        output: { type: "json", value: { stdout: "/home/user" } },
      });
      expect(result[2].role).toBe("assistant");
      expect((result[2] as AssistantModelMessage).content).toEqual([
        { type: "text", text: "After" },
      ]);
    });

    it("should interleave multiple tool-call groups with their results", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "Step 1" },
          { type: "tool-call", toolCallId: "call1", toolName: "bash", input: { script: "pwd" } },
          { type: "text", text: "Step 2" },
          { type: "tool-call", toolCallId: "call2", toolName: "bash", input: { script: "ls" } },
        ],
      };
      const toolMsg: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: { stdout: "/workspace" } },
          },
          {
            type: "tool-result",
            toolCallId: "call2",
            toolName: "bash",
            output: { type: "json", value: { stdout: "file.txt" } },
          },
        ],
      };

      const result = transformModelMessages([assistantMsg, toolMsg], "anthropic");

      expect(result).toHaveLength(4);
      expect(result[0].role).toBe("assistant");
      expect((result[0] as AssistantModelMessage).content).toEqual([
        { type: "text", text: "Step 1" },
        { type: "tool-call", toolCallId: "call1", toolName: "bash", input: { script: "pwd" } },
      ]);
      expect(result[1].role).toBe("tool");
      expect((result[1] as ToolModelMessage).content[0]).toMatchObject({ toolCallId: "call1" });
      expect(result[2].role).toBe("assistant");
      expect((result[2] as AssistantModelMessage).content).toEqual([
        { type: "text", text: "Step 2" },
        { type: "tool-call", toolCallId: "call2", toolName: "bash", input: { script: "ls" } },
      ]);
      expect(result[3].role).toBe("tool");
      expect((result[3] as ToolModelMessage).content[0]).toMatchObject({ toolCallId: "call2" });
    });

    it("preserves signed reasoning in assistant messages that contain tool calls when thinking is enabled", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: { anthropic: { signature: "sig" } },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          { type: "text", text: "I'll check." },
          { type: "tool-call", toolCallId: "call1", toolName: "bash", input: { script: "pwd" } },
        ],
      };
      const toolMsg: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: { stdout: "/home/user" } },
          },
        ],
      };

      const result = transformModelMessages([assistantMsg, toolMsg], "anthropic", {
        anthropicThinkingEnabled: true,
      });

      expect(result).toHaveLength(2);
      expect((result[0] as AssistantModelMessage).content[0]).toMatchObject({ type: "reasoning" });
      expect(getAnthropicThinkingDisableReason(result)).toBeUndefined();
    });

    it("should insert empty reasoning for final assistant message when Anthropic thinking is enabled", () => {
      const messages: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        { role: "assistant", content: [{ type: "text", text: "Subagent report text" }] },
        { role: "user", content: [{ type: "text", text: "Continue" }] },
      ];

      const result = transformModelMessages(messages, "anthropic", {
        anthropicThinkingEnabled: true,
      });

      // Find last assistant message and ensure it starts with reasoning
      const lastAssistant = [...result]
        .reverse()
        .find((m): m is AssistantModelMessage => m.role === "assistant");
      expect(lastAssistant).toBeTruthy();
      expect(Array.isArray(lastAssistant?.content)).toBe(true);
      if (Array.isArray(lastAssistant?.content)) {
        expect(lastAssistant.content[0]).toEqual({ type: "reasoning", text: "..." });
      }
    });
    it("merges consecutive text-only assistant messages (Anthropic alternation)", () => {
      // Previously passed through unchanged; since synthetic assistant rows
      // (branch summaries) can follow a streamed assistant turn, consecutive
      // text-only assistant messages now merge like consecutive user messages.
      const assistantMsg1: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Let me help you with that." }],
      };
      const assistantMsg2: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Here's the result." }],
      };
      const messages: ModelMessage[] = [assistantMsg1, assistantMsg2];

      const result = transformModelMessages(messages, "anthropic");
      // Original text parts are preserved as separate blocks so part-level
      // providerOptions survive the merge.
      expect(result).toEqual([
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me help you with that." },
            { type: "text", text: "Here's the result." },
          ],
        },
      ]);
    });

    it("coalesces 3 consecutive identical no-progress task_await pairs into 1 (keep last pair)", () => {
      const input = { task_ids: ["task1"], timeout_secs: 10 };

      const assistantMsg1: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call1", toolName: "task_await", input }],
      };
      const toolMsg1: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "task_await",
            output: {
              type: "json",
              value: { results: [{ status: "running", taskId: "task1" }] },
            },
          },
        ],
      };

      const assistantMsg2: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call2", toolName: "task_await", input }],
      };
      const toolMsg2: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call2",
            toolName: "task_await",
            output: {
              type: "json",
              value: { results: [{ status: "running", taskId: "task1" }] },
            },
          },
        ],
      };

      const assistantMsg3: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call3", toolName: "task_await", input }],
      };
      const toolMsg3: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call3",
            toolName: "task_await",
            output: {
              type: "json",
              value: { results: [{ status: "running", taskId: "task1" }] },
            },
          },
        ],
      };

      const result = transformModelMessages(
        [assistantMsg1, toolMsg1, assistantMsg2, toolMsg2, assistantMsg3, toolMsg3],
        "anthropic"
      );

      expect(result).toEqual([assistantMsg3, toolMsg3]);
    });

    it("does not coalesce task_await polls when a later poll returns progress", () => {
      const input = { task_ids: ["task1"], timeout_secs: 10 };

      const assistantMsg1: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call1", toolName: "task_await", input }],
      };
      const toolMsg1: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "task_await",
            output: {
              type: "json",
              value: { results: [{ status: "running", taskId: "task1" }] },
            },
          },
        ],
      };

      const assistantMsg2: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call2", toolName: "task_await", input }],
      };
      const toolMsg2: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call2",
            toolName: "task_await",
            output: {
              type: "json",
              value: { results: [{ status: "running", taskId: "task1" }] },
            },
          },
        ],
      };

      // Progress: output is non-empty.
      const assistantMsg3: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call3", toolName: "task_await", input }],
      };
      const toolMsg3: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call3",
            toolName: "task_await",
            output: {
              type: "json",
              value: { results: [{ status: "running", taskId: "task1", output: "new output" }] },
            },
          },
        ],
      };

      const result = transformModelMessages(
        [assistantMsg1, toolMsg1, assistantMsg2, toolMsg2, assistantMsg3, toolMsg3],
        "anthropic"
      );

      // The no-progress polls are coalesced, but the progress poll must remain.
      expect(result).toEqual([assistantMsg2, toolMsg2, assistantMsg3, toolMsg3]);
    });

    it("preserves Anthropic tool_use/tool_result adjacency after coalescing task_await polls", () => {
      const input = { task_ids: ["task1"], timeout_secs: 10 };

      const messages: ModelMessage[] = [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call1", toolName: "task_await", input }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call1",
              toolName: "task_await",
              output: {
                type: "json",
                value: { results: [{ status: "running", taskId: "task1" }] },
              },
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call2", toolName: "task_await", input }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call2",
              toolName: "task_await",
              output: {
                type: "json",
                value: { results: [{ status: "running", taskId: "task1" }] },
              },
            },
          ],
        },
      ];

      const result = transformModelMessages(messages, "anthropic");
      expect(validateAnthropicCompliance(result).valid).toBe(true);
    });
  });

  describe("getAnthropicThinkingDisableReason", () => {
    it("returns a reason when tool-call message lacks signed reasoning", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call1", toolName: "bash", input: {} }],
      };
      const toolMsg: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: {} },
          },
        ],
      };

      const reason = getAnthropicThinkingDisableReason([assistantMsg, toolMsg]);
      expect(reason).toContain("Message 0");
    });

    it("returns undefined when tool-call message starts with signed reasoning", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "...",
            providerOptions: { anthropic: { signature: "sig" } },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          { type: "tool-call", toolCallId: "call1", toolName: "bash", input: {} },
        ],
      };
      const toolMsg: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: {} },
          },
        ],
      };

      expect(getAnthropicThinkingDisableReason([assistantMsg, toolMsg])).toBeUndefined();
    });

    it("treats unsigned reasoning as absent", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: [
          { type: "reasoning", text: "..." },
          { type: "tool-call", toolCallId: "call1", toolName: "bash", input: {} },
        ],
      };
      const toolMsg: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: {} },
          },
        ],
      };

      const reason = getAnthropicThinkingDisableReason([assistantMsg, toolMsg]);
      expect(reason).toContain("Message 0");
    });
  });

  describe("validateAnthropicCompliance", () => {
    it("should validate correct message sequences", () => {
      const assistantMsg1: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call1", toolName: "bash", input: {} }],
      };
      const toolMsg: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: {} },
          },
        ],
      };
      const assistantMsg2: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Done!" }],
      };
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
        assistantMsg1,
        toolMsg,
        assistantMsg2,
      ];

      const result = validateAnthropicCompliance(messages);
      expect(result.valid).toBe(true);
    });

    it("should detect tool calls without results", () => {
      const assistantMsg1: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call1", toolName: "bash", input: {} }],
      };
      const assistantMsg2: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Something else" }],
      };
      const messages: ModelMessage[] = [assistantMsg1, assistantMsg2];

      const result = validateAnthropicCompliance(messages);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("tool_use blocks found without tool_result");
    });

    it("should detect mismatched tool results", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call1", toolName: "bash", input: {} }],
      };
      const toolMsg: ToolModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call2",
            toolName: "bash",
            output: { type: "json", value: {} },
          },
        ],
      };
      const messages: ModelMessage[] = [assistantMsg, toolMsg];

      const result = validateAnthropicCompliance(messages);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("no corresponding tool_use");
    });

    it("should handle string content in assistant messages", () => {
      const assistantMsg: AssistantModelMessage = {
        role: "assistant",
        content: "Just a string message",
      };
      const messages: ModelMessage[] = [
        assistantMsg,
        {
          role: "user",
          content: [{ type: "text", text: "Reply" }],
        },
      ];

      const result = validateAnthropicCompliance(messages);
      expect(result.valid).toBe(true);
    });
  });

  describe("consecutive user messages", () => {
    it("should keep single user message unchanged", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      ];

      const result = transformModelMessages(messages, "anthropic");
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("user");
      expect((result[0].content as Array<{ type: string; text: string }>)[0].text).toBe("Hello");
    });

    it("should merge two consecutive user messages with newline", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "World" }],
        },
      ];

      const result = transformModelMessages(messages, "anthropic");
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("user");
      expect((result[0].content as Array<{ type: string; text: string }>)[0].text).toBe(
        "Hello\nWorld"
      );
    });

    it("should merge three consecutive user messages with newlines", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "First" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Second" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Third" }],
        },
      ];

      const result = transformModelMessages(messages, "anthropic");
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("user");
      expect((result[0].content as Array<{ type: string; text: string }>)[0].text).toBe(
        "First\nSecond\nThird"
      );
    });

    it("should not merge user messages separated by assistant message", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi there!" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "How are you?" }],
        },
      ];

      const result = transformModelMessages(messages, "anthropic");
      expect(result).toHaveLength(3);
      expect(result[0].role).toBe("user");
      expect((result[0].content as Array<{ type: string; text: string }>)[0].text).toBe("Hello");
      expect(result[1].role).toBe("assistant");
      expect(result[2].role).toBe("user");
      expect((result[2].content as Array<{ type: string; text: string }>)[0].text).toBe(
        "How are you?"
      );
    });
  });

  describe("consecutive assistant messages", () => {
    it("merges a text-only synthetic assistant row into the preceding assistant turn", () => {
      // Branch summaries are assistant-role synthetic rows that can land
      // directly after a streamed assistant turn; Anthropic rejects
      // consecutive assistant messages just like consecutive user messages.
      const messages: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: "question" }] },
        { role: "assistant", content: [{ type: "text", text: "branch point answer" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "Summary of the abandoned branch: explored a race." }],
        },
        { role: "user", content: [{ type: "text", text: "first send on the fork" }] },
      ];
      const result = transformModelMessages(messages, "anthropic");
      expect(result).toHaveLength(3);
      expect(result[1].role).toBe("assistant");
      // Original text parts preserved verbatim as separate blocks (never
      // re-joined into one string, which would drop part providerOptions).
      expect(result[1].content).toEqual([
        { type: "text", text: "branch point answer" },
        { type: "text", text: "Summary of the abandoned branch: explored a race." },
      ]);
      // Alternation restored for Anthropic.
      expect(result.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    });

    it("preserves part providerOptions and only merges for Anthropic", () => {
      // The folded row's text parts keep their providerOptions (e.g.
      // cacheControl); other providers accept consecutive assistant rows, so
      // the merge must not change their request bytes.
      const messages: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: "question" }] },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Summary.",
              providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
            },
          ],
        },
      ];
      const anthropic = transformModelMessages(messages, "anthropic");
      expect(anthropic).toHaveLength(2);
      expect(anthropic[1].content).toEqual([
        { type: "text", text: "answer" },
        {
          type: "text",
          text: "Summary.",
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
      ]);
      // Non-Anthropic providers: consecutive assistant rows pass through.
      expect(transformModelMessages(messages, "openai")).toEqual(messages);
      expect(transformModelMessages(messages, "google")).toEqual(messages);
    });

    it("filters empty text parts from both sides of the merge", () => {
      // History recorded with extended thinking can carry a signed-reasoning
      // assistant row whose trailing text part is empty; when a synthetic
      // summary merges into it (replayed with thinking off — reasoning parts
      // inside mixed rows are preserved), the previous row's empty block must
      // be dropped too, not just the incoming row's — Anthropic rejects empty
      // text blocks. The signed reasoning part itself is preserved verbatim.
      // (With thinking ON the summary row gains a placeholder reasoning part
      // and is no longer text-only, so this merge does not fire there.)
      const messages: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: "question" }] },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "thinking...",
              providerOptions: { anthropic: { signature: "sig" } },
            },
            { type: "text", text: "" },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Summary of the abandoned branch: explored a race." }],
        },
      ];
      const result = transformModelMessages(messages, "anthropic");
      expect(result).toHaveLength(2);
      expect(result[1].content).toEqual([
        {
          type: "reasoning",
          text: "thinking...",
          providerOptions: { anthropic: { signature: "sig" } },
        },
        { type: "text", text: "Summary of the abandoned branch: explored a race." },
      ]);
    });

    it("filters whitespace-only text from both sides of the merge (r46)", () => {
      // An interrupted stream can persist a whitespace-only text delta on the
      // signed-reasoning row; Anthropic rejects text blocks without
      // non-whitespace content, so a nonzero-length whitespace part must be
      // dropped like an empty one — from the previous row's parts and from
      // incoming string content alike.
      const messages: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: "question" }] },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "thinking...",
              providerOptions: { anthropic: { signature: "sig" } },
            },
            { type: "text", text: "  \n" },
          ],
        },
        { role: "assistant", content: "Summary of the abandoned branch: explored a race." },
        { role: "assistant", content: " \t" },
      ];
      const result = transformModelMessages(messages, "anthropic");
      expect(result).toHaveLength(2);
      expect(result[1].content).toEqual([
        {
          type: "reasoning",
          text: "thinking...",
          providerOptions: { anthropic: { signature: "sig" } },
        },
        { type: "text", text: "Summary of the abandoned branch: explored a race." },
      ]);
    });

    it("keeps a summary row standalone after a tool-call/tool-result pair", () => {
      // Tool-call/tool-result adjacency must stay intact: when the branch
      // point turn ended in tool calls, the summary follows the TOOL message
      // and must not be folded backwards across it.
      const messages: ModelMessage[] = [
        { role: "user", content: [{ type: "text", text: "question" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool-call", toolCallId: "t1", toolName: "bash", input: {} },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "t1",
              toolName: "bash",
              output: { type: "text", value: "ok" },
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Summary of the abandoned branch: stalled." }],
        },
      ];
      const result = transformModelMessages(messages, "anthropic");
      expect(result.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
      const validation = validateAnthropicCompliance(result);
      expect(validation.valid).toBe(true);
    });
  });

  describe("addInterruptedSentinel", () => {
    it("should insert user message after partial assistant message", () => {
      const messages: MuxMessage[] = [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
          metadata: { timestamp: 1000 },
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Let me help..." }],
          metadata: { timestamp: 2000, partial: true },
        },
      ];

      const result = addInterruptedSentinel(messages);

      // Should have 3 messages: user, assistant, [CONTINUE] user
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe("user-1");
      expect(result[1].id).toBe("assistant-1");
      expect(result[2].id).toBe("interrupted-assistant-1");
      expect(result[2].role).toBe("user");
      expect(result[2].parts).toEqual([{ type: "text", text: "[CONTINUE]" }]);
      expect(result[2].metadata?.synthetic).toBe(true);
      expect(result[2].metadata?.timestamp).toBe(2000);
    });

    it("should not insert sentinel for non-partial assistant messages", () => {
      const messages: MuxMessage[] = [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
          metadata: { timestamp: 1000 },
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Complete response" }],
          metadata: { timestamp: 2000, partial: false },
        },
      ];

      const result = addInterruptedSentinel(messages);

      // Should remain unchanged (no sentinel)
      expect(result).toHaveLength(2);
      expect(result).toEqual(messages);
    });

    it("should insert sentinel for reasoning-only partial messages", () => {
      const messages: MuxMessage[] = [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Calculate something" }],
          metadata: { timestamp: 1000 },
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "reasoning", text: "Let me think about this..." }],
          metadata: { timestamp: 2000, partial: true },
        },
      ];

      const result = addInterruptedSentinel(messages);

      // Should have 3 messages: user, assistant (reasoning only), [CONTINUE] user
      expect(result).toHaveLength(3);
      expect(result[2].role).toBe("user");
      expect(result[2].parts).toEqual([{ type: "text", text: "[CONTINUE]" }]);
    });

    it("should handle multiple partial messages", () => {
      const messages: MuxMessage[] = [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "First" }],
          metadata: { timestamp: 1000 },
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Response 1..." }],
          metadata: { timestamp: 2000, partial: true },
        },
        {
          id: "user-2",
          role: "user",
          parts: [{ type: "text", text: "Second" }],
          metadata: { timestamp: 3000 },
        },
        {
          id: "assistant-2",
          role: "assistant",
          parts: [{ type: "text", text: "Response 2..." }],
          metadata: { timestamp: 4000, partial: true },
        },
      ];

      const result = addInterruptedSentinel(messages);

      // Should have 5 messages:
      // - user-1, assistant-1 (partial), user-2 (NO SENTINEL - user follows), assistant-2 (partial), SENTINEL (last message)
      expect(result).toHaveLength(5);
      expect(result[0].id).toBe("user-1");
      expect(result[1].id).toBe("assistant-1");
      expect(result[2].id).toBe("user-2"); // No sentinel between assistant-1 and user-2
      expect(result[3].id).toBe("assistant-2");
      expect(result[4].id).toBe("interrupted-assistant-2"); // Sentinel after last partial
      expect(result[4].role).toBe("user");
    });

    it("should skip sentinel when user message follows partial", () => {
      const messages: MuxMessage[] = [
        {
          id: "user-1",
          role: "user",
          parts: [{ type: "text", text: "Question" }],
          metadata: { timestamp: 1000 },
        },
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Starting response..." }],
          metadata: { timestamp: 2000, partial: true },
        },
        {
          id: "user-2",
          role: "user",
          parts: [{ type: "text", text: "Follow-up question" }],
          metadata: { timestamp: 3000 },
        },
      ];

      const result = addInterruptedSentinel(messages);

      // Should have 3 messages (no sentinel added because user-2 follows partial)
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe("user-1");
      expect(result[1].id).toBe("assistant-1");
      expect(result[2].id).toBe("user-2");
      // No synthetic sentinel should exist
      expect(result.every((msg) => !msg.metadata?.synthetic)).toBe(true);
    });
  });

  describe("reasoning part handling for OpenAI", () => {
    it("should preserve reasoning parts for OpenAI provider (managed via explicit history)", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Solve this problem" }],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "Let me think about this..." },
            { type: "text", text: "Here's the solution" },
          ],
        },
      ];

      const result = transformModelMessages(messages, "openai");

      // Should have 2 messages, assistant message should keep reasoning + text
      expect(result).toHaveLength(2);
      expect(result[1].role).toBe("assistant");
      expect((result[1] as AssistantModelMessage).content).toEqual([
        { type: "reasoning", text: "Let me think about this..." },
        { type: "text", text: "Here's the solution" },
      ]);
    });

    it("should preserve reasoning parts for Anthropic provider", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Solve this problem" }],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "Let me think about this..." },
            { type: "text", text: "Here's the solution" },
          ],
        },
      ];

      const result = transformModelMessages(messages, "anthropic");

      // Should have 2 messages, assistant message should have both reasoning and text
      expect(result).toHaveLength(2);
      expect(result[1].role).toBe("assistant");
      const content = (result[1] as AssistantModelMessage).content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content).toHaveLength(2);
        expect(content[0]).toEqual({ type: "reasoning", text: "Let me think about this..." });
        expect(content[1]).toEqual({ type: "text", text: "Here's the solution" });
      }
    });

    it("should filter out reasoning-only messages for OpenAI", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Calculate something" }],
        },
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "Let me think..." }],
        },
      ];

      const result = transformModelMessages(messages, "openai");

      // Should only have user message, reasoning-only assistant message should be filtered out
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("user");
    });

    it("should preserve tool calls when stripping reasoning for OpenAI", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Run a command" }],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "I need to check something..." },
            { type: "text", text: "Let me check" },
            { type: "tool-call", toolCallId: "call1", toolName: "bash", input: { script: "pwd" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call1",
              toolName: "bash",
              output: { type: "json", value: { stdout: "/home/user" } },
            },
          ],
        },
      ];

      const result = transformModelMessages(messages, "openai");

      // Should still contain user, assistant, and tool messages after filtering
      expect(result.length).toBeGreaterThan(2);

      // Find the assistant message with text (reasoning should remain alongside text)
      const textMessage = result.find((msg) => {
        if (msg.role !== "assistant") return false;
        const content = msg.content;
        return Array.isArray(content) && content.some((c) => c.type === "text");
      });
      expect(textMessage).toBeDefined();
      if (textMessage) {
        const content = (textMessage as AssistantModelMessage).content;
        if (Array.isArray(content)) {
          expect(content.some((c) => c.type === "reasoning")).toBe(true);
          expect(content.some((c) => c.type === "text")).toBe(true);
        }
      }

      // Find the assistant message with tool-call
      const toolCallMessage = result.find((msg) => {
        if (msg.role !== "assistant") return false;
        const content = msg.content;
        return Array.isArray(content) && content.some((c) => c.type === "tool-call");
      });
      expect(toolCallMessage).toBeDefined();
    });

    it("should handle multiple reasoning parts for OpenAI", () => {
      const messages: ModelMessage[] = [
        {
          role: "user",
          content: [{ type: "text", text: "Complex task" }],
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "First, I'll consider..." },
            { type: "reasoning", text: "Then, I'll analyze..." },
            { type: "text", text: "Final answer" },
          ],
        },
      ];

      const result = transformModelMessages(messages, "openai");

      // Should have 2 messages, assistant should keep all reasoning + text (coalesced)
      expect(result).toHaveLength(2);
      expect(result[1].role).toBe("assistant");
      expect((result[1] as AssistantModelMessage).content).toEqual([
        { type: "reasoning", text: "First, I'll consider...Then, I'll analyze..." },
        { type: "text", text: "Final answer" },
      ]);
    });
  });
});

describe("stripOrphanedToolCalls", () => {
  it("drops tool calls without results and orphaned tool results", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "Run it" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call1", toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call2",
            toolName: "bash",
            output: { type: "json", value: { stdout: "orphan" } },
          },
        ],
      },
    ];

    const result = stripOrphanedToolCalls(messages);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("keeps tool results embedded in assistant messages when paired", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call1", toolName: "bash", input: {} },
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: { stdout: "inline" } },
          },
        ],
      },
    ];

    const result = stripOrphanedToolCalls(messages);

    expect(result).toEqual(messages);
  });

  it("drops orphaned tool results embedded in assistant messages", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "No tool call" },
          {
            type: "tool-result",
            toolCallId: "call2",
            toolName: "bash",
            output: { type: "json", value: { stdout: "inline" } },
          },
        ],
      },
    ];

    const result = stripOrphanedToolCalls(messages);

    expect(result).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "No tool call" }],
      },
    ]);
  });

  it("keeps tool calls and results when they match", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call1", toolName: "bash", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call1",
            toolName: "bash",
            output: { type: "json", value: { stdout: "ok" } },
          },
        ],
      },
    ];

    const result = stripOrphanedToolCalls(messages);

    expect(result).toEqual(messages);
  });
});

describe("injectAgentTransition", () => {
  it("should inject transition message when agent changes", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Let's plan a feature" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Here's the plan..." }],
        metadata: { timestamp: 2000, agentId: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Now execute it" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const result = injectAgentTransition(messages, "exec");

    // Should have 4 messages: user, assistant, agent-transition, user
    expect(result.length).toBe(4);

    // Third message should be agent transition
    expect(result[2].role).toBe("user");
    expect(result[2].metadata?.synthetic).toBe(true);
    expect(result[2].parts[0]).toMatchObject({
      type: "text",
      text: "[Agent switched from plan to exec. Follow exec agent instructions.]",
    });

    // Original messages should be preserved
    expect(result[0]).toEqual(messages[0]);
    expect(result[1]).toEqual(messages[1]);
    expect(result[3]).toEqual(messages[2]); // Last user message shifted
  });

  it("should not inject transition when agent is the same", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Let's plan" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Planning..." }],
        metadata: { timestamp: 2000, agentId: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Continue planning" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const result = injectAgentTransition(messages, "plan");

    // Should be unchanged
    expect(result.length).toBe(3);
    expect(result).toEqual(messages);
  });

  it("should not inject transition when no previous agent exists", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { timestamp: 1000 },
      },
    ];

    const result = injectAgentTransition(messages, "exec");

    // Should be unchanged (no assistant message to compare)
    expect(result.length).toBe(1);
    expect(result).toEqual(messages);
  });

  it("should not inject transition when no agent specified", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hi" }],
        metadata: { timestamp: 2000, agentId: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const result = injectAgentTransition(messages, undefined);

    // Should be unchanged
    expect(result.length).toBe(3);
    expect(result).toEqual(messages);
  });

  it("should handle conversation with no user messages", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Hi" }],
        metadata: { timestamp: 2000, agentId: "plan" },
      },
    ];

    const result = injectAgentTransition(messages, "exec");

    // Should be unchanged (no user message to inject before)
    expect(result.length).toBe(1);
    expect(result).toEqual(messages);
  });

  it("should include tool names in transition message when provided", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Let's plan a feature" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Here's the plan..." }],
        metadata: { timestamp: 2000, agentId: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Now execute it" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const toolNames = ["file_read", "bash", "file_edit_replace_string", "web_search"];
    const result = injectAgentTransition(messages, "exec", toolNames);

    // Should have 4 messages: user, assistant, agent-transition, user
    expect(result.length).toBe(4);

    // Third message should be agent transition with tool names
    expect(result[2].role).toBe("user");
    expect(result[2].metadata?.synthetic).toBe(true);
    expect(result[2].parts[0]).toMatchObject({
      type: "text",
      text: "[Agent switched from plan to exec. Follow exec agent instructions. Available tools: file_read, bash, file_edit_replace_string, web_search.]",
    });
  });

  it("should handle agent transition without tools parameter (backward compatibility)", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Let's plan" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Planning..." }],
        metadata: { timestamp: 2000, agentId: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Execute" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const result = injectAgentTransition(messages, "exec");

    // Should have 4 messages with transition, but no tool info
    expect(result.length).toBe(4);
    expect(result[2].parts[0]).toMatchObject({
      type: "text",
      text: "[Agent switched from plan to exec. Follow exec agent instructions.]",
    });
  });

  it("should handle agent transition with empty tool list", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Let's plan" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Planning..." }],
        metadata: { timestamp: 2000, agentId: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Execute" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const result = injectAgentTransition(messages, "exec", []);

    // Should have 4 messages with transition, but no tool info (empty array handled gracefully)
    expect(result.length).toBe(4);
    expect(result[2].parts[0]).toMatchObject({
      type: "text",
      text: "[Agent switched from plan to exec. Follow exec agent instructions.]",
    });
  });

  it("should include plan content when transitioning from plan to exec", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Let's plan a feature" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Here's the plan..." }],
        metadata: { timestamp: 2000, agentId: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Now execute it" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const planContent = "# My Plan\n\n## Step 1\nDo something\n\n## Step 2\nDo more";
    const planFilePath = "~/.mux/plans/demo/ws-123.md";
    const result = injectAgentTransition(messages, "exec", undefined, planContent, planFilePath);

    expect(result.length).toBe(4);
    const transitionMessage = result[2];
    expect(transitionMessage.role).toBe("user");
    expect(transitionMessage.metadata?.synthetic).toBe(true);

    const textPart = transitionMessage.parts[0];
    expect(textPart.type).toBe("text");
    if (textPart.type === "text") {
      expect(textPart.text).toContain(
        "[Agent switched from plan to exec. Follow exec agent instructions.]"
      );
      expect(textPart.text).toContain(`Plan file path: ${planFilePath}`);
      expect(textPart.text).toContain("The following plan was developed in the plan agent");
      expect(textPart.text).toContain("<plan>");
      expect(textPart.text).toContain(planContent);
      expect(textPart.text).toContain("</plan>");
    }
  });

  it("should NOT include plan content when transitioning from exec to plan", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Done with feature" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Feature complete" }],
        metadata: { timestamp: 2000, agentId: "exec" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Let's plan the next one" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const planContent = "# Old Plan\n\nSome content";
    const result = injectAgentTransition(messages, "plan", undefined, planContent);

    expect(result.length).toBe(4);
    const transitionMessage = result[2];
    const textPart = transitionMessage.parts[0];
    if (textPart.type === "text") {
      expect(textPart.text).toBe(
        "[Agent switched from exec to plan. Follow plan agent instructions.]"
      );
      expect(textPart.text).not.toContain("<plan>");
    }
  });

  it("should NOT include plan content when no plan content provided", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Let's plan" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Planning..." }],
        metadata: { timestamp: 2000, agentId: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Execute" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const result = injectAgentTransition(messages, "exec", undefined, undefined);

    expect(result.length).toBe(4);
    const transitionMessage = result[2];
    const textPart = transitionMessage.parts[0];
    if (textPart.type === "text") {
      expect(textPart.text).toBe(
        "[Agent switched from plan to exec. Follow exec agent instructions.]"
      );
      expect(textPart.text).not.toContain("<plan>");
    }
  });

  it("should include both tools and plan content in transition message", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Plan done" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Plan ready" }],
        metadata: { timestamp: 2000, agentId: "plan" },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Go" }],
        metadata: { timestamp: 3000 },
      },
    ];

    const toolNames = ["file_read", "bash"];
    const planContent = "# Plan\n\nDo stuff";
    const result = injectAgentTransition(messages, "exec", toolNames, planContent);

    expect(result.length).toBe(4);
    const textPart = result[2].parts[0];
    if (textPart.type === "text") {
      expect(textPart.text).toContain("Available tools: file_read, bash.]");
      expect(textPart.text).toContain("<plan>");
      expect(textPart.text).toContain(planContent);
    }
  });
});

describe("filterEmptyAssistantMessages", () => {
  it("should filter out assistant messages with only reasoning when preserveReasoningOnly=false", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Let me think about this..." }],
        metadata: { timestamp: 2000 },
      },
    ];

    const result = filterEmptyAssistantMessages(messages, false);

    // Reasoning-only message should be filtered out
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("user-1");
  });

  it("should filter out assistant messages with empty parts array (placeholder messages)", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [], // Empty placeholder message
        metadata: { timestamp: 2000 },
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [], // Another empty placeholder
        metadata: { timestamp: 3000 },
      },
    ];

    // Empty messages should be filtered out regardless of preserveReasoningOnly
    const result1 = filterEmptyAssistantMessages(messages, false);
    expect(result1.length).toBe(1);
    expect(result1[0].id).toBe("user-1");

    const result2 = filterEmptyAssistantMessages(messages, true);
    expect(result2.length).toBe(1);
    expect(result2[0].id).toBe("user-1");
  });

  it("should preserve assistant messages with only reasoning when preserveReasoningOnly=true", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Let me think about this..." }],
        metadata: { timestamp: 2000 },
      },
    ];

    const result = filterEmptyAssistantMessages(messages, true);

    // Reasoning-only message should be preserved when preserveReasoningOnly=true
    expect(result.length).toBe(2);
    expect(result[1].id).toBe("assistant-1");
    expect(result[1].parts).toEqual([{ type: "reasoning", text: "Let me think about this..." }]);
  });

  it("should preserve assistant messages with text content regardless of preserveReasoningOnly", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Thinking..." },
          { type: "text", text: "Here's my answer" },
        ],
        metadata: { timestamp: 2000 },
      },
    ];

    // With preserveReasoningOnly=false
    const result1 = filterEmptyAssistantMessages(messages, false);
    expect(result1.length).toBe(1);
    expect(result1[0].id).toBe("assistant-1");

    // With preserveReasoningOnly=true
    const result2 = filterEmptyAssistantMessages(messages, true);
    expect(result2.length).toBe(1);
    expect(result2[0].id).toBe("assistant-1");
  });

  it("should filter out assistant messages with only incomplete tool calls (input-available)", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Run a command" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            state: "input-available",
            toolCallId: "call-1",
            toolName: "bash",
            input: { script: "pwd" },
          },
        ],
        metadata: { timestamp: 2000, partial: true },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        metadata: { timestamp: 3000 },
      },
    ];

    // Incomplete tool calls are dropped by convertToModelMessages(ignoreIncompleteToolCalls: true),
    // so we must treat them as empty here to avoid generating an invalid request.
    const result = filterEmptyAssistantMessages(messages, false);
    expect(result.map((m) => m.id)).toEqual(["user-1", "user-2"]);
  });

  it("should preserve assistant messages with completed tool calls (output-available)", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Run a command" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            state: "output-available",
            toolCallId: "call-1",
            toolName: "bash",
            input: { script: "pwd" },
            output: { stdout: "/home/user" },
          },
        ],
        metadata: { timestamp: 2000 },
      },
    ];

    const result = filterEmptyAssistantMessages(messages, false);
    expect(result.map((m) => m.id)).toEqual(["user-1", "assistant-1"]);
  });
  it("should filter out assistant messages with only empty/whitespace text regardless of preserveReasoningOnly", () => {
    const emptyTexts = ["", "\n\n", "   "];

    for (const text of emptyTexts) {
      const messages: MuxMessage[] = [
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text }],
          metadata: { timestamp: 2000 },
        },
      ];

      // With preserveReasoningOnly=false
      const result1 = filterEmptyAssistantMessages(messages, false);
      expect(result1.length).toBe(0);

      // With preserveReasoningOnly=true
      const result2 = filterEmptyAssistantMessages(messages, true);
      expect(result2.length).toBe(0);
    }
  });

  it("should preserve messages interrupted during thinking phase when preserveReasoningOnly=true", () => {
    // Simulates an interrupted stream during Extended Thinking
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Solve this problem" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Let me analyze this step by step..." }],
        metadata: { timestamp: 2000, partial: true },
      },
    ];

    // When thinking is disabled, filter out reasoning-only message
    const result1 = filterEmptyAssistantMessages(messages, false);
    expect(result1.length).toBe(1);
    expect(result1[0].id).toBe("user-1");

    // When thinking is enabled, preserve it for API compliance
    const result2 = filterEmptyAssistantMessages(messages, true);
    expect(result2.length).toBe(2);
    expect(result2[1].id).toBe("assistant-1");
    expect(result2[1].metadata?.partial).toBe(true);
  });
});

describe("injectPostCompactionAttachments", () => {
  it("inserts after the compaction summary and enforces a size budget", () => {
    const messages: MuxMessage[] = [
      {
        id: "compaction-summary",
        role: "assistant",
        parts: [{ type: "text", text: "Compacted summary" }],
        metadata: {
          timestamp: 1000,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 1,
        },
      },
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        metadata: { timestamp: 1100 },
      },
    ];

    const attachments = [
      {
        type: "edited_files_reference" as const,
        files: [
          {
            path: "src/huge.ts",
            diff: "x".repeat(MAX_POST_COMPACTION_INJECTION_CHARS + 10_000),
            truncated: false,
          },
        ],
      },
    ];

    const result = injectPostCompactionAttachments(messages, attachments);

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("compaction-summary");
    expect(result[2].id).toBe("user-1");

    const injected = result[1];
    expect(injected.role).toBe("user");
    expect(injected.metadata?.synthetic).toBe(true);

    const text = (injected.parts[0] as { type: "text"; text: string }).text;
    expect(text.length).toBeLessThanOrEqual(MAX_POST_COMPACTION_INJECTION_CHARS);
    expect(text).toContain("post-compaction context truncated");
  });

  it("falls back to a legacy compacted summary when durable boundary metadata is missing", () => {
    const messages: MuxMessage[] = [
      {
        id: "legacy-summary",
        role: "assistant",
        parts: [{ type: "text", text: "Legacy compacted summary" }],
        metadata: {
          timestamp: 1000,
          compacted: true,
        },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Assistant context after summary" }],
        metadata: { timestamp: 1050 },
      },
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        metadata: { timestamp: 1100 },
      },
    ];

    const attachments = [
      {
        type: "plan_file_reference" as const,
        planFilePath: "PLAN.md",
        planContent: "Legacy plan",
      },
    ];

    const result = injectPostCompactionAttachments(messages, attachments);

    expect(result).toHaveLength(4);
    expect(result[0].id).toBe("legacy-summary");

    const injected = result[1];
    expect(injected.metadata?.synthetic).toBe(true);
    expect(injected.metadata?.timestamp).toBe(1000);
    const text = (injected.parts[0] as { type: "text"; text: string }).text;
    expect(text).toContain("<system-update>");

    expect(result[2].id).toBe("assistant-1");
    expect(result[3].id).toBe("user-1");
  });

  it("appends at the end when no compaction indicators are present", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Initial question" }],
        metadata: { timestamp: 1000 },
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Initial response" }],
        metadata: { timestamp: 1010 },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Follow-up" }],
        metadata: { timestamp: 1020 },
      },
    ];

    const attachments = [
      {
        type: "plan_file_reference" as const,
        planFilePath: "PLAN.md",
        planContent: "Fallback plan",
      },
    ];

    const result = injectPostCompactionAttachments(messages, attachments);

    expect(result).toHaveLength(4);
    expect(result[0].id).toBe("user-1");
    expect(result[1].id).toBe("assistant-1");
    expect(result[2].id).toBe("user-2");

    const appended = result[3];
    expect(appended.metadata?.synthetic).toBe(true);
    const text = (appended.parts[0] as { type: "text"; text: string }).text;
    expect(text).toContain("<system-update>");
  });

  it("inserts after the latest compaction boundary when multiple summaries exist", () => {
    const messages: MuxMessage[] = [
      {
        id: "summary-1",
        role: "assistant",
        parts: [{ type: "text", text: "Older summary" }],
        metadata: {
          timestamp: 1000,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 1,
        },
      },
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Between summaries" }],
        metadata: { timestamp: 1100 },
      },
      {
        id: "summary-2",
        role: "assistant",
        parts: [{ type: "text", text: "Latest summary" }],
        metadata: {
          timestamp: 2000,
          compacted: "user",
          compactionBoundary: true,
          compactionEpoch: 2,
        },
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        metadata: { timestamp: 2100 },
      },
    ];

    const attachments = [
      {
        type: "plan_file_reference" as const,
        planFilePath: "PLAN.md",
        planContent: "Latest plan",
      },
    ];

    const result = injectPostCompactionAttachments(messages, attachments);

    expect(result).toHaveLength(5);
    expect(result[0].id).toBe("summary-1");
    expect(result[1].id).toBe("user-1");
    expect(result[2].id).toBe("summary-2");

    const injected = result[3];
    expect(injected.metadata?.synthetic).toBe(true);
    const text = (injected.parts[0] as { type: "text"; text: string }).text;
    expect(text).toContain("<system-update>");

    expect(result[4].id).toBe("user-2");
  });
});
