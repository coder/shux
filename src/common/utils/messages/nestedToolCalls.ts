import type { DynamicToolPart } from "@/common/types/toolParts";

type NestedToolCalls = NonNullable<DynamicToolPart["nestedCalls"]>;

function getObjectField(value: unknown, field: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[field]
    : undefined;
}

function reconstructCodeExecutionNestedCalls(part: DynamicToolPart): NestedToolCalls | undefined {
  if (part.toolName !== "code_execution" || part.state !== "output-available") {
    return undefined;
  }

  const toolCalls = getObjectField(part.output, "toolCalls");
  if (!Array.isArray(toolCalls)) {
    return undefined;
  }

  const nestedCalls: NestedToolCalls = [];
  for (const [idx, toolCall] of toolCalls.entries()) {
    if (typeof toolCall !== "object" || toolCall === null) {
      continue;
    }
    const record = toolCall as Record<string, unknown>;
    if (typeof record.toolName !== "string" || typeof record.duration_ms !== "number") {
      continue;
    }

    const output =
      record.result ??
      (typeof record.error === "string"
        ? // success:false matches the failure shape tool cards and
          // isFailedToolOutput already understand, so the error stays
          // visible (e.g. bash's ErrorBox) after reload.
          { success: false, error: record.error }
        : undefined);
    // RLM kernel-mode compact record (r12): the full nested result never
    // persists in the tool output, so degraded detail after reload is expected
    // (live streaming keeps full detail via part.nestedCalls, which takes
    // precedence). Failure travels out-of-band via `failed` instead of a
    // synthetic output shape, so a real tool result can never be mistaken
    // for a reconstruction stand-in.
    const kernelFailure = output === undefined && record.ok === false;

    nestedCalls.push({
      toolCallId: `${part.toolCallId}-nested-${idx}`,
      toolName: record.toolName,
      input: record.args,
      output,
      ...(kernelFailure ? { failed: true } : {}),
      state: "output-available",
      timestamp: part.timestamp,
    });
  }

  return nestedCalls.length > 0 ? nestedCalls : undefined;
}

export function getNestedCallsForDisplay(part: DynamicToolPart): NestedToolCalls | undefined {
  return part.nestedCalls ?? reconstructCodeExecutionNestedCalls(part);
}
