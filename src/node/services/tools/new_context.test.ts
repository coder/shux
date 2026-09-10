import { describe, expect, test } from "bun:test";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { createTestToolConfig, mockToolCallOptions } from "./testHelpers";
import { createNewContextTool } from "./new_context";

describe("new_context tool", () => {
  test("takes no arguments and only reports a scheduled request", async () => {
    const tool = createNewContextTool(createTestToolConfig("/tmp", { workspaceId: "ws" }));
    expect(TOOL_DEFINITIONS.new_context.schema.safeParse({}).success).toBe(true);
    // Strict: a model cannot smuggle notes or a reason through this tool.
    expect(TOOL_DEFINITIONS.new_context.schema.safeParse({ notes: "x" }).success).toBe(false);
    const result = TOOL_DEFINITIONS.new_context.resultSchema.parse(
      await tool.execute!({}, mockToolCallOptions)
    );
    expect(result).toMatchObject({ success: true, status: "scheduled" });
    expect(TOOL_DEFINITIONS.new_context.ptcExcluded).toBeString();
  });
});
