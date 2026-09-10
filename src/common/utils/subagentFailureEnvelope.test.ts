import { describe, expect, test } from "bun:test";
import { formatSubagentFailureUserMessage } from "@/node/services/taskWorkspaceSeam";
import { parseSubagentFailureEnvelope } from "./subagentFailureEnvelope";

const failure = {
  childWorkspaceId: "task-123",
  agentType: "exec",
  errorType: "workspace_turn_superseded",
  errorMessage: "New input took over.\nThe workspace continues.",
};

describe("parseSubagentFailureEnvelope", () => {
  test("round-trips producer messages with each combination of optional execution metadata", () => {
    for (const metadata of [
      {},
      { executionId: "wst_123" },
      { executionVersion: "wst_123:interrupted:2026-09-04T12:04:40.370Z" },
      { executionId: "wst_123", executionVersion: "wst_123:failed:2026-09-04T12:04:40.370Z" },
    ]) {
      expect(
        parseSubagentFailureEnvelope(formatSubagentFailureUserMessage({ ...failure, ...metadata }))
      ).toEqual({
        taskId: failure.childWorkspaceId,
        agentType: failure.agentType,
        errorType: failure.errorType,
        errorMessage: failure.errorMessage,
        ...metadata,
      });
    }
  });

  test("preserves delimiter examples and whitespace inside error messages", () => {
    const errorMessage = `    Diagnostic:\n${formatSubagentFailureUserMessage(failure)}\n  trailing  `;
    expect(
      parseSubagentFailureEnvelope(formatSubagentFailureUserMessage({ ...failure, errorMessage }))
        ?.errorMessage
    ).toBe(errorMessage);
  });

  test("rejects incomplete envelopes, empty required fields, and surrounding content", () => {
    const valid = formatSubagentFailureUserMessage(failure);
    for (const content of [
      "ordinary message",
      valid.replace("</error_message>", ""),
      valid.replace("<task_id>task-123</task_id>", "<task_id> </task_id>"),
      valid.replace(failure.errorMessage, " "),
      `Before\n${valid}`,
      `${valid}\nAfter`,
    ]) {
      expect(parseSubagentFailureEnvelope(content)).toBeNull();
    }
  });
});
