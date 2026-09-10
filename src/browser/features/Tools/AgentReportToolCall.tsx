import React from "react";

import type { AgentReportToolArgs, AgentReportToolResult } from "@/common/types/tools";
import { AgentReportToolResultSchema } from "@/common/utils/tools/toolDefinitions";

import { ErrorBox } from "./Shared/ToolPrimitives";
import { AgentCommunicationCard } from "./Shared/AgentCommunicationCard";
import {
  isToolErrorResult,
  normalizeToolResultForRendering,
  type ToolStatus,
} from "./Shared/toolUtils";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";

interface LegacyAgentReportFileArgs {
  reportMarkdownPath?: string | null;
  structuredOutputPath?: string | null;
  title?: string | null;
}

type AgentReportRenderableArgs = AgentReportToolArgs | LegacyAgentReportFileArgs;

interface AgentReportToolCallProps {
  args: AgentReportRenderableArgs;
  result?: unknown;
  status?: ToolStatus;
}

function getSubmittedReportMarkdown(
  args: AgentReportRenderableArgs,
  result: AgentReportToolResult | undefined
): string {
  if (result && "success" in result && result.success === true && result.report?.reportMarkdown) {
    return result.report.reportMarkdown;
  }
  if ("reportMarkdown" in args) {
    return args.reportMarkdown;
  }
  return `Report file: ${args.reportMarkdownPath ?? "report.md"}`;
}

export const AgentReportToolCall: React.FC<AgentReportToolCallProps> = (props) => {
  // Persisted results bypass input-schema validation and may be malformed.
  const normalizedResult = normalizeToolResultForRendering(props.result);
  const parsed = AgentReportToolResultSchema.safeParse(normalizedResult);
  const result = isToolErrorResult(normalizedResult)
    ? normalizedResult
    : parsed.success
      ? parsed.data
      : undefined;
  const invalidResult = (props.result != null || props.status === "completed") && result == null;
  const reportMarkdown = getSubmittedReportMarkdown(props.args, result);
  const failedResult = result?.success === false ? result : null;
  const title = props.args.title?.trim() ?? "";

  return (
    <AgentCommunicationCard
      toolName="agent_report"
      title={title.length > 0 ? title : "Agent update"}
      destination="To parent"
      status={failedResult || invalidResult ? "failed" : (props.status ?? "pending")}
      statusLabel={invalidResult ? "Result unavailable" : undefined}
      preview={reportMarkdown}
      initiallyExpanded
      error={
        failedResult && (
          <ErrorBox className="mt-2" role="alert">
            {isToolErrorResult(failedResult) ? (
              failedResult.error
            ) : (
              <>
                {failedResult.message}
                {failedResult.errors.map((error, index) => (
                  <div key={index}>
                    {error.path}: {error.message}
                  </div>
                ))}
              </>
            )}
          </ErrorBox>
        )
      }
    >
      <MarkdownRenderer content={reportMarkdown} className="text-sm leading-relaxed" />
    </AgentCommunicationCard>
  );
};
