export interface SubagentFailureEnvelope {
  taskId: string;
  agentType: string;
  errorType: string;
  errorMessage: string;
  executionVersion?: string;
  executionId?: string;
}

/** Parse the persisted failure protocol without changing the model-facing message. */
export function parseSubagentFailureEnvelope(content: string): SubagentFailureEnvelope | null {
  // Match the entire producer envelope so malformed or mixed-content messages remain visible as-is.
  // The error body is greedy: embedded protocol examples must not truncate the actual diagnostic.
  const match =
    /^<mux_subagent_failure>\n<task_id>([^\n<>]+)<\/task_id>\n(?:<execution_version>([^\n<>]+)<\/execution_version>\n)?(?:<execution_id>([^\n<>]+)<\/execution_id>\n)?<agent_type>([^\n<>]+)<\/agent_type>\n<error_type>([^\n<>]+)<\/error_type>\n<error_message>\n([\s\S]+)\n<\/error_message>\nThis sub-agent task failed terminally and will not produce a report\. Do not re-await it\.\n<\/mux_subagent_failure>$/.exec(
      content
    );
  if (!match) return null;

  const [, taskId, executionVersion, executionId, agentType, errorType, errorMessage] = match;
  if (![taskId, agentType, errorType, errorMessage].every((field) => field.trim().length > 0)) {
    return null;
  }
  return {
    taskId,
    agentType,
    errorType,
    errorMessage,
    ...(executionVersion ? { executionVersion } : {}),
    ...(executionId ? { executionId } : {}),
  };
}
