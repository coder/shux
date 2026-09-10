import { describe, expect, it, mock } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import { Err, Ok, type Result } from "@/common/types/result";
import type {
  AgentTreeTargetRelation,
  SendAgentTaskMessageResult,
  SendAgentTreeMessageError,
  TaskService,
} from "@/node/services/taskService";

import { createTaskSendMessageTool } from "./task_send_message";
import { createTestToolConfig, TestTempDir } from "./testHelpers";

type TreeSendResult = Result<
  SendAgentTaskMessageResult & { relation: AgentTreeTargetRelation },
  SendAgentTreeMessageError
>;

const toolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "task-send-message-call",
  messages: [],
  context: undefined,
};

describe("task_send_message tool", () => {
  it("passes the raw dispatch mode through and maps the routing relation onto the result", async () => {
    using tempDir = new TestTempDir("task-send-message-delivery");
    const sendAgentTreeMessage = mock(
      (): Promise<TreeSendResult> =>
        Promise.resolve(
          Ok({ delivery: "queued", queueDispatchMode: "tool-end", relation: "target_descendant" })
        )
    );
    const taskService = { sendAgentTreeMessage } as unknown as TaskService;
    const tool = createTaskSendMessageTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "parent" }),
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!({ task_id: "child", message: "Use the API response type." }, toolCallOptions)
    );

    // The default dispatch mode is relation-dependent, so the tool must not apply one itself.
    expect(sendAgentTreeMessage).toHaveBeenCalledWith(
      "parent",
      "child",
      "Use the API response type.",
      undefined
    );
    expect(result).toEqual({
      status: "queued",
      taskId: "child",
      queueDispatchMode: "tool-end",
      targetRelation: "descendant",
    });
  });

  it("labels sibling deliveries with the peer relation", async () => {
    using tempDir = new TestTempDir("task-send-message-sibling");
    const sendAgentTreeMessage = mock(
      (): Promise<TreeSendResult> => Promise.resolve(Ok({ delivery: "accepted", relation: "peer" }))
    );
    const taskService = { sendAgentTreeMessage } as unknown as TaskService;
    const tool = createTaskSendMessageTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "sib-a" }),
      taskService,
    });

    expect(
      await Promise.resolve(
        tool.execute!({ task_id: "sib-b", message: "Schema changed." }, toolCallOptions)
      )
    ).toEqual({ status: "accepted", taskId: "sib-b", targetRelation: "sibling" });
  });

  it("maps inactive child reawakening without exposing the internal execution handle", async () => {
    using tempDir = new TestTempDir("task-send-message-reactivated");
    const sendAgentTreeMessage = mock(
      (): Promise<TreeSendResult> =>
        Promise.resolve(
          Ok({
            delivery: "reactivated",
            executionTaskId: "wst_internal_execution",
            relation: "target_descendant",
          })
        )
    );
    const taskService = { sendAgentTreeMessage } as unknown as TaskService;
    const tool = createTaskSendMessageTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "parent" }),
      taskService,
    });

    expect(
      await Promise.resolve(
        tool.execute!(
          { task_id: "child", message: "Investigate the new failure." },
          toolCallOptions
        )
      )
    ).toEqual({ status: "reactivated", taskId: "child" });
  });

  it("maps scope, task-state, and throttle failures to actionable results", async () => {
    using tempDir = new TestTempDir("task-send-message-errors");
    const outcomes: SendAgentTreeMessageError[] = [
      { code: "invalid_scope" },
      { code: "not_active", taskStatus: "reported" },
      { code: "refused", reason: "Best-of candidates cannot send or receive peer messages." },
      { code: "rate_limited", retryAfterMs: 1500.4 },
    ];
    const taskService = {
      sendAgentTreeMessage: mock(
        (): Promise<TreeSendResult> => Promise.resolve(Err(outcomes.shift()!))
      ),
    } as unknown as TaskService;
    const tool = createTaskSendMessageTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "parent" }),
      taskService,
    });

    const invalidScopeResult: unknown = await Promise.resolve(
      tool.execute!(
        { task_id: "other", message: "Correction", queue_dispatch_mode: "turn-end" },
        toolCallOptions
      )
    );
    expect(invalidScopeResult).toEqual({ status: "invalid_scope", taskId: "other" });

    const notActiveResult: unknown = await Promise.resolve(
      tool.execute!({ task_id: "finished", message: "Correction" }, toolCallOptions)
    );
    expect(notActiveResult).toEqual({
      status: "not_active",
      taskId: "finished",
      taskStatus: "reported",
      error: "Task is reported and cannot accept messages.",
    });

    const refusedResult: unknown = await Promise.resolve(
      tool.execute!({ task_id: "cand", message: "Correction" }, toolCallOptions)
    );
    expect(refusedResult).toEqual({
      status: "refused",
      taskId: "cand",
      reason: "Best-of candidates cannot send or receive peer messages.",
    });

    // Fractional retry hints round up so the schema's integer contract holds.
    const rateLimitedResult: unknown = await Promise.resolve(
      tool.execute!({ task_id: "busy", message: "Correction" }, toolCallOptions)
    );
    expect(rateLimitedResult).toEqual({
      status: "rate_limited",
      taskId: "busy",
      retryAfterMs: 1501,
    });
  });
});
