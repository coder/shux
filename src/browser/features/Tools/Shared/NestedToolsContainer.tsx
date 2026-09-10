import React from "react";
import { NestedToolRenderer } from "./NestedToolRenderer";
import { getNestedToolStatus } from "./toolUtils";
import type { NestedToolCall } from "./codeExecutionTypes";

interface NestedToolsContainerProps {
  calls: NestedToolCall[];
  /** When true, incomplete tools show as interrupted instead of executing */
  parentInterrupted?: boolean;
  workspaceId?: string;
  toolCallTimestamp?: number;
}

/**
 * Renders nested tool calls as a list.
 * The parent owns the border and padding. Preserve that inset for every nested
 * tool: cancelling it with negative margins makes bordered cards touch the frame
 * and forces each new tool renderer to work around the nesting layout.
 */
export const NestedToolsContainer: React.FC<NestedToolsContainerProps> = ({
  calls,
  parentInterrupted,
  workspaceId,
  toolCallTimestamp,
}) => {
  if (calls.length === 0) return null;

  return (
    <div className="space-y-3">
      {calls.map((call) => {
        const status = getNestedToolStatus(
          call.state,
          call.output,
          parentInterrupted ?? false,
          call.failed
        );
        return (
          <NestedToolRenderer
            key={call.toolCallId}
            toolName={call.toolName}
            input={call.input}
            output={call.state === "output-available" ? call.output : undefined}
            status={status}
            workspaceId={workspaceId}
            toolCallId={call.toolCallId}
            toolCallTimestamp={call.timestamp ?? toolCallTimestamp}
            workflowRunHint={call.workflowRun}
          />
        );
      })}
    </div>
  );
};
