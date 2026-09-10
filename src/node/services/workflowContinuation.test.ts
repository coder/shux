/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, mock, test } from "bun:test";
import { DisposableTempDir } from "./tempDir";
import { WorkflowRunStore } from "./workflows/WorkflowRunStore";
import { sendWorkflowRunTerminalContinuation } from "./workflowContinuation";

describe("sendWorkflowRunTerminalContinuation", () => {
  test("sends the workflow result with the original invocation settings", async () => {
    using temp = new DisposableTempDir("workflow-continuation");
    const store = new WorkflowRunStore({ sessionDir: temp.path });
    await store.createRun({
      id: "wfr_continue",
      workspaceId: "workspace-1",
      workflow: {
        name: "demo",
        description: "Demo",
        scope: "built-in",
        sourcePath: "./workflows/demo.js",
        executable: true,
      },
      source: "export default function workflow() { return {}; }\n",
      args: {},
      now: "2026-05-29T00:00:00.000Z",
    });
    const run = await store.getRun("wfr_continue");
    const sendMessage = mock(
      async (_workspaceId: string, _message: string, _options: unknown, _flags: unknown) => ({
        success: true as const,
        data: undefined,
      })
    );
    const service = {
      isWorkflowInvocationCurrent: mock(async () => true),
      getWorkflowContinuationSendOptions: mock(async () => null),
      sendMessage,
    } as unknown as Parameters<typeof sendWorkflowRunTerminalContinuation>[0];

    await sendWorkflowRunTerminalContinuation(service, {
      workspaceId: "workspace-1",
      rawCommand: "workflow_run ./workflows/demo.js",
      name: "./workflows/demo.js",
      runId: run.id,
      status: "completed",
      result: { reportMarkdown: "done" },
      run,
      continuationOptions: { model: "test:model", agentId: "exec" },
    });

    expect(sendMessage.mock.calls[0]?.[0]).toBe("workspace-1");
    expect(sendMessage.mock.calls[0]?.[1]).toContain("<mux_workflow_result>");
    expect(sendMessage.mock.calls[0]?.[2]).toMatchObject({
      model: "test:model",
      agentId: "exec",
      skipAiSettingsPersistence: true,
      muxMetadata: {
        type: "workflow-result",
        rawCommand: "workflow_run ./workflows/demo.js",
        commandPrefix: "workflow_run",
        runId: "wfr_continue",
        requestedModel: "test:model",
      },
    });
    expect(sendMessage.mock.calls[0]?.[3]).toMatchObject({
      skipAutoResumeReset: true,
      synthetic: true,
      agentInitiated: true,
      requireIdle: true,
      startStreamInBackground: true,
    });
  });
});
