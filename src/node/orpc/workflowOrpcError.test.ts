import { describe, expect, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { WorkflowArgsValidationError } from "@/node/services/workflows/workflowArgs";
import { throwWorkflowOrpcError } from "./formatOrpcError";

describe("throwWorkflowOrpcError", () => {
  test("preserves workflow bad-request messages", () => {
    for (const error of [
      new Error("Dynamic workflows are disabled"),
      new WorkflowArgsValidationError("Workflow argument topic is required"),
    ]) {
      try {
        throwWorkflowOrpcError(error);
      } catch (thrown) {
        expect(thrown).toBeInstanceOf(ORPCError);
        expect(thrown).toHaveProperty("code", "BAD_REQUEST");
        expect(thrown).toHaveProperty("message", error.message);
      }
    }
  });

  test("rethrows unrelated errors", () => {
    const error = new Error("unrelated");
    expect(() => throwWorkflowOrpcError(error)).toThrow(error);
  });
});
