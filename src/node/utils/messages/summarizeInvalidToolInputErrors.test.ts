import { describe, expect, test } from "bun:test";
import { InvalidToolInputError, TypeValidationError, type TextStreamPart, type ToolSet } from "ai";
import { z } from "zod";
import { summarizeInvalidToolInputErrors } from "./summarizeInvalidToolInputErrors";

async function runTransform(
  parts: Array<TextStreamPart<ToolSet>>
): Promise<Array<TextStreamPart<ToolSet>>> {
  const transform = summarizeInvalidToolInputErrors<ToolSet>()({
    tools: {},
    stopStream: () => undefined,
  });
  const output: Array<TextStreamPart<ToolSet>> = [];
  await new ReadableStream<TextStreamPart<ToolSet>>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  })
    .pipeThrough(transform)
    .pipeTo(
      new WritableStream({
        write(part) {
          output.push(part);
        },
      })
    );
  return output;
}

function rejectedCall(toolCallId: string, input: unknown, cause: unknown) {
  const error = new InvalidToolInputError({
    toolName: "note",
    toolInput: JSON.stringify(input),
    cause,
  });
  return {
    call: {
      type: "tool-call" as const,
      toolCallId,
      toolName: "note",
      input,
      dynamic: true as const,
      invalid: true,
      error,
    },
    toolError: {
      type: "tool-error" as const,
      toolCallId,
      toolName: "note",
      input,
      error: error.message,
      dynamic: true as const,
    },
  };
}

describe("summarizeInvalidToolInputErrors", () => {
  test("rewrites only the rejected call's tool-error and leaves other errors alone", async () => {
    const schema = z.object({ text: z.string().max(5) });
    const input = { text: "toolong" };
    const validation = schema.safeParse(input);
    if (validation.success) throw new Error("Expected the schema to reject the input");
    const rejected = rejectedCall(
      "rejected",
      input,
      TypeValidationError.wrap({ value: input, cause: validation.error })
    );
    const executionFailure = {
      type: "tool-error" as const,
      toolCallId: "executed",
      toolName: "note",
      input: { text: "ok" },
      error: new Error("disk full"),
    };

    const output = await runTransform([rejected.call, rejected.toolError, executionFailure]);

    expect(output).toHaveLength(3);
    expect(output[0]).toBe(rejected.call);
    expect(output[1]).toMatchObject({
      type: "tool-error",
      toolCallId: "rejected",
      error:
        "Invalid input for tool note: text: Too big: expected string to have <=5 characters (received 7 characters)",
    });
    expect(output[2]).toBe(executionFailure);
  });

  test("falls back to the error message when the cause chain has no issues", async () => {
    const rejected = rejectedCall("unparsable", "{not json", new Error("JSON parsing failed"));

    const output = await runTransform([rejected.call, rejected.toolError]);

    expect(output[1]).toMatchObject({ type: "tool-error", error: rejected.toolError.error });
  });
});
