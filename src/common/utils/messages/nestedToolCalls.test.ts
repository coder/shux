import { expect, test } from "bun:test";
import type { MuxToolPart } from "@/common/types/message";
import { getNestedCallsForDisplay } from "./nestedToolCalls";

const part: MuxToolPart = {
  type: "dynamic-tool",
  toolCallId: "parent",
  toolName: "code_execution",
  input: {},
  state: "output-available",
  output: { toolCalls: [{ toolName: "bash", result: "legacy", duration_ms: 1 }] },
};

test("explicit nested arrays retain precedence and identity, including empty arrays", () => {
  for (const nestedCalls of [
    [],
    [{ toolCallId: "live", toolName: "file_read", state: "input-available" as const }],
  ]) {
    expect(getNestedCallsForDisplay({ ...part, nestedCalls })).toBe(nestedCalls);
  }
  expect(getNestedCallsForDisplay(part)?.[0]?.output).toBe("legacy");
});

test("legacy records are reconstructed only for completed code_execution output", () => {
  expect(getNestedCallsForDisplay({ ...part, toolName: "bash" })).toBeUndefined();
  expect(getNestedCallsForDisplay({ ...part, state: "input-available" })).toBeUndefined();
  expect(getNestedCallsForDisplay({ ...part, state: "output-redacted" })).toBeUndefined();
  expect(getNestedCallsForDisplay({ ...part, output: { toolCalls: "invalid" } })).toBeUndefined();
});

test("malformed records are skipped while falsy results and original ordering survive", () => {
  const calls = getNestedCallsForDisplay({
    ...part,
    output: {
      toolCalls: [
        null,
        { toolName: "invalid", duration_ms: "one" },
        {
          toolName: "bash",
          result: false,
          error: "must not replace a real result",
          duration_ms: 2,
        },
        { toolName: "file_read", result: 0, duration_ms: 3 },
      ],
    },
  });
  expect(calls?.map((call) => call.toolName)).toEqual(["bash", "file_read"]);
  expect(calls?.map((call) => call.output)).toEqual([false, 0]);
  expect(calls?.map((call) => call.toolCallId)).toEqual(["parent-nested-2", "parent-nested-3"]);
});
