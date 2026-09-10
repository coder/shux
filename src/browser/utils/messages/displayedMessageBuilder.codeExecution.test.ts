import { describe, expect, test } from "bun:test";

import { createMuxMessage } from "@/common/types/message";
import { buildDisplayedMessagesForMessage } from "./displayedMessageBuilder";

/**
 * Reload rendering of persisted code_execution records (no streamed
 * nestedCalls on the part — e.g. old histories or truncated streams): the
 * builder reconstructs nested calls from result.toolCalls. RLM kernel-mode
 * records are compact summaries (r12) and must reconstruct without crashing.
 */
function buildToolRow(toolCalls: unknown[]) {
  const message = createMuxMessage("m1", "assistant", "", undefined, [
    {
      type: "dynamic-tool",
      toolCallId: "call-1",
      toolName: "code_execution",
      state: "output-available",
      input: { code: "return 1;" },
      output: {
        success: true,
        result: 1,
        toolCalls,
        consoleOutput: [],
        duration_ms: 5,
      },
    },
  ]);
  const displayed = buildDisplayedMessagesForMessage({
    message,
    hasActiveStream: false,
    isContextBoundaryMessage: () => false,
  });
  const row = displayed.find((m) => m.type === "tool");
  if (row?.type !== "tool") throw new Error("expected tool row");
  return row;
}

describe("buildDisplayedMessagesForMessage code_execution nested-call reconstruction", () => {
  test("RLM-off full records pass the inline result through (unchanged behavior)", () => {
    const row = buildToolRow([
      { toolName: "bash", args: { cmd: "ls" }, result: { output: "a b c" }, duration_ms: 3 },
    ]);
    expect(row.nestedCalls).toHaveLength(1);
    expect(row.nestedCalls?.[0]?.output).toEqual({ output: "a b c" });
  });

  test("kernel compact records reconstruct without a synthetic output", () => {
    const row = buildToolRow([
      { toolName: "bash", args: { cmd: "ls" }, ok: true, bytes: 12345, duration_ms: 3 },
      { toolName: "bash", args: { cmd: "false" }, ok: false, bytes: 0, duration_ms: 1 },
      { toolName: "bash", args: { cmd: "rm" }, ok: false, bytes: 0, error: "boom", duration_ms: 1 },
    ]);
    expect(row.nestedCalls).toHaveLength(3);
    // No fabricated output shape: a real tool result could collide with it,
    // so failure travels out-of-band via the failed flag instead.
    expect(row.nestedCalls?.[0]?.output).toBeUndefined();
    expect(row.nestedCalls?.[0]?.failed).toBeUndefined();
    expect(row.nestedCalls?.[1]?.output).toBeUndefined();
    expect(row.nestedCalls?.[1]?.failed).toBe(true);
    // Failure detail stays visible on reload, in the failure shape tool
    // cards already understand.
    expect(row.nestedCalls?.[2]?.output).toEqual({ success: false, error: "boom" });
    expect(row.nestedCalls?.[2]?.failed).toBeUndefined();
  });
});
