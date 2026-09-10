import type { ComponentType } from "react";

import { setupSimpleChatStory } from "./chatSetup";
import { collapseLeftSidebar, collapseRightSidebar } from "./uiState";
import {
  createAssistantMessage,
  createSubagentReportMessage,
  createUserMessage,
} from "../mocks/messages";
import { STABLE_TIMESTAMP } from "../mocks/workspaces";

const REPORT_MESSAGES = [
  createUserMessage("report-user", "Review the message rendering path and flag any UX gaps.", {
    historySequence: 1,
    timestamp: STABLE_TIMESTAMP - 180_000,
  }),
  createAssistantMessage(
    "report-assistant",
    "I delegated the rendering trace and asked the sub-agent to report important findings as they land.",
    {
      historySequence: 2,
      timestamp: STABLE_TIMESTAMP - 170_000,
    }
  ),
  createSubagentReportMessage("report-progress", {
    historySequence: 3,
    timestamp: STABLE_TIMESTAMP - 120_000,
    taskId: "18c2511cea",
    agentType: "explore",
    status: "in_progress",
    model: "anthropic:claude-opus-5",
    thinkingLevel: "high",
    title: "Current report presentation traced across the parent transcript",
    reportMarkdown:
      "Parent-side reports currently expose the model-facing envelope. A dedicated renderer can preserve **markdown**, paths like `src/browser/features/Messages/UserMessage.tsx`, and status without the raw protocol.",
  }),
  createSubagentReportMessage("report-complete", {
    historySequence: 4,
    timestamp: STABLE_TIMESTAMP - 60_000,
    taskId: "18c2511cea",
    agentType: "explore",
    // Omit status to cover report envelopes persisted before incremental updates existed.
    model: "anthropic:claude-opus-5",
    thinkingLevel: "high",
    title: "Presentation recommendation complete",
    reportMarkdown: [
      "## Recommendation",
      "",
      "- Render reports as trusted sub-agent findings, not ordinary user input.",
      "- Keep structured workflow data available without letting it dominate the transcript.",
    ].join("\n"),
    structuredOutput: {
      affectedFiles: [
        "src/browser/features/Messages/UserMessage.tsx",
        "src/browser/features/Messages/SubagentReportMessageContent.tsx",
      ],
      mobileVerified: true,
    },
  }),
  createAssistantMessage(
    "report-integrated",
    "I’ll incorporate both findings into the final implementation and keep the structured details available for inspection.",
    {
      historySequence: 5,
      timestamp: STABLE_TIMESTAMP - 50_000,
    }
  ),
] as const;

export function setupSubagentReportStory() {
  collapseLeftSidebar();
  collapseRightSidebar();
  return setupSimpleChatStory({
    workspaceId: "ws-subagent-report-presentation",
    workspaceName: "subagent-reports",
    projectName: "mux",
    messages: [...REPORT_MESSAGES],
  });
}

export function setupSubagentFailureStory() {
  collapseLeftSidebar();
  collapseRightSidebar();
  return setupSimpleChatStory({
    workspaceId: "ws-subagent-failure-presentation",
    workspaceName: "subagent-failures",
    projectName: "mux",
    messages: [
      createUserMessage("failure-user", "Have the agents review the changes and run the tests.", {
        historySequence: 1,
        timestamp: STABLE_TIMESTAMP - 180_000,
      }),
      ...[
        {
          taskId: "94f98c6165",
          agentType: "exec",
          errorType: "workspace_turn_superseded",
          errorMessage:
            "Workspace turn superseded by new input in the target workspace; the workspace continues under that input and this delegated turn will not report",
        },
        {
          taskId: "28a75e1b09",
          agentType: "explore",
          errorType: "process_exit",
          errorMessage: "The agent process exited unexpectedly before it could finish the review.",
        },
      ].map((failure, index) =>
        createUserMessage(
          `failure-${index}`,
          `<mux_subagent_failure>
<task_id>${failure.taskId}</task_id>
<execution_version>wst_f804f6a7a6:interrupted:2026-09-04T12:04:40.370Z</execution_version>
<execution_id>wst_f804f6a7a6</execution_id>
<agent_type>${failure.agentType}</agent_type>
<error_type>${failure.errorType}</error_type>
<error_message>
${failure.errorMessage}
</error_message>
This sub-agent task failed terminally and will not produce a report. Do not re-await it.
</mux_subagent_failure>`,
          {
            historySequence: index + 2,
            timestamp: STABLE_TIMESTAMP - 120_000 + index * 60_000,
            synthetic: true,
          }
        )
      ),
    ],
  });
}

export function PhoneSubagentReportDecorator(Story: ComponentType) {
  return (
    <div style={{ width: 390, maxWidth: "100%", height: 844, overflow: "hidden" }}>
      <Story />
    </div>
  );
}
