import type { MuxMessage } from "@/common/types/message";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import assert from "@/common/utils/assert";

export const WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE = "workflow-trigger-display";
export const WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE = "workflow-run-card-display";
export const WORKFLOW_RESULT_METADATA_TYPE = "workflow-result";

/**
 * Tools whose output-available parts carry the run record/runId of a workflow run the agent
 * owns. Card-projection guards, provenance scans, supersession checks, and preview seeding all
 * answer this same membership question across browser and node layers — route them through
 * this single predicate so a future run-emitting tool is a one-line change.
 */
export const WORKFLOW_RUN_EMITTING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "workflow_run",
  "workflow_resume",
]);

export function isWorkflowRunEmittingToolName(toolName: string): boolean {
  return WORKFLOW_RUN_EMITTING_TOOL_NAMES.has(toolName);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * workflow_run / workflow_resume outputs embed the full run record (script source, event
 * log, step snapshots) solely for the UI run card. The model only needs status/runId/result —
 * in-progress events may never materialize in the final outcome — so drop the record from
 * model-bound copies (persisted-history requests and internal stream steps alike) while the
 * persisted output keeps rendering the card.
 */
export function isTerminalWorkflowRunToolOutput(
  toolName: string,
  output: unknown,
  runId: string
): boolean {
  assert(runId.length > 0, "isTerminalWorkflowRunToolOutput: runId is required");
  if (!isWorkflowRunEmittingToolName(toolName) || !isRecordValue(output)) {
    return false;
  }
  if (output.type === "json" && "value" in output) {
    return isTerminalWorkflowRunToolOutput(toolName, output.value, runId);
  }
  const status = output.status;
  return (
    output.runId === runId &&
    (status === "completed" || status === "failed" || status === "interrupted")
  );
}

export function stripWorkflowRunRecordForModel(toolName: string, output: unknown): unknown {
  if (!isWorkflowRunEmittingToolName(toolName) || !isRecordValue(output)) {
    return output;
  }
  // Tool outputs may be wrapped in a { type: "json", value } container (UI parts and
  // SDK ToolResultPart outputs share this shape).
  if (output.type === "json" && "value" in output) {
    const strippedValue = stripWorkflowRunRecordForModel(toolName, output.value);
    return strippedValue === output.value ? output : { ...output, value: strippedValue };
  }
  if (!("run" in output)) {
    return output;
  }
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output)) {
    if (key !== "run") {
      stripped[key] = value;
    }
  }
  return stripped;
}

export const WORKFLOW_RESULT_XML_TAG = "mux_workflow_result";

/**
 * First sentence of the opening, split out so the timeline can recognize a workflow-result turn from
 * its text alone: a coalesced terminal-attention wake carries this section without the
 * workflow-result metadata. Matching uses this sentence rather than the full opening because timeline
 * row digests are truncated to 120 characters, which the full opening exceeds.
 */
export const WORKFLOW_RESULT_MESSAGE_OPENING_SENTENCE = "The workflow below has finished.";

export const WORKFLOW_RESULT_MESSAGE_OPENING =
  `${WORKFLOW_RESULT_MESSAGE_OPENING_SENTENCE} Continue the agent turn for the original request ` +
  "using this workflow result. Do not merely restate the raw payload; synthesize the next answer or " +
  "action from it.";

function getWorkflowResultValue(result: unknown, run: WorkflowRunRecord | null): unknown {
  if (result != null) {
    return result;
  }
  return run?.events.findLast((event) => event.type === "result")?.result ?? result;
}

function getWorkflowError(input: {
  run: WorkflowRunRecord | null;
  status: string;
  resultValue: unknown;
}): string | undefined {
  if (input.status !== "failed" && input.resultValue != null) {
    return undefined;
  }
  return input.run?.events.findLast((event) => event.type === "error")?.message;
}

function getWorkflowResultField(value: unknown, field: string): unknown {
  if (value != null && typeof value === "object") {
    return (value as Record<string, unknown>)[field];
  }
  return undefined;
}

/**
 * agent()-based workflows return `{ reportMarkdown, structuredOutput }` — exactly the fields
 * hoisted to the payload top level. Repeating them verbatim under `result` doubled the token
 * cost of every workflow-completion context message, so `result` keeps only fields that were
 * NOT hoisted (non-standard result shapes) and is dropped when nothing else remains.
 */
function getResidualWorkflowResult(
  resultValue: unknown,
  hoistedFields: readonly string[]
): unknown {
  if (hoistedFields.length === 0 || !isRecordValue(resultValue)) {
    return resultValue;
  }
  const residual: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resultValue)) {
    if (!hoistedFields.includes(key)) {
      residual[key] = value;
    }
  }
  return Object.keys(residual).length > 0 ? residual : null;
}

function stringifyWorkflowResultPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return JSON.stringify({ error: "Workflow result could not be serialized." }, null, 2);
  }
}

export function buildWorkflowResultContextMessage(input: {
  rawCommand: string;
  name: string;
  runId: string;
  status: string;
  result: unknown;
  run: WorkflowRunRecord | null;
}): string {
  assert(
    input.rawCommand.trim().length > 0,
    "buildWorkflowResultContextMessage: rawCommand required"
  );
  assert(input.name.length > 0, "buildWorkflowResultContextMessage: workflow name required");
  assert(input.runId.length > 0, "buildWorkflowResultContextMessage: runId required");

  const resultValue = getWorkflowResultValue(input.result, input.run);
  const reportMarkdown = getWorkflowResultField(resultValue, "reportMarkdown");
  const structuredOutput = getWorkflowResultField(resultValue, "structuredOutput");
  const hoistedFields = [
    ...(typeof reportMarkdown === "string" ? ["reportMarkdown"] : []),
    ...(structuredOutput !== undefined ? ["structuredOutput"] : []),
  ];
  const residualResult = getResidualWorkflowResult(resultValue, hoistedFields);
  const workflowError = getWorkflowError({
    run: input.run,
    status: input.status,
    resultValue,
  });
  const payload = {
    workflow: {
      name: input.name,
      runId: input.runId,
      status: input.status,
    },
    ...(typeof reportMarkdown === "string" ? { reportMarkdown } : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(residualResult != null ? { result: residualResult } : {}),
    ...(workflowError ? { error: workflowError } : {}),
  };

  return [
    WORKFLOW_RESULT_MESSAGE_OPENING,
    `Original workflow command: ${input.rawCommand}`,
    `<${WORKFLOW_RESULT_XML_TAG}>\n${stringifyWorkflowResultPayload(payload)}\n</${WORKFLOW_RESULT_XML_TAG}>`,
  ].join("\n\n");
}

/**
 * Recognize this run's result payload inside a coalesced terminal-attention prompt from the
 * builder's own output format. The drain's synthetic user row can coalesce several runs into
 * one message and carries no workflow-result metadata, so currentness checks must read the
 * consumption evidence out of the text: each payload block is parsed back and matched on the
 * exact workflow.runId the builder wrote, not on a raw substring, so a run ID merely quoted
 * inside another run's report cannot count as consumption.
 */
export function textContainsWorkflowResultPayload(text: string, runId: string): boolean {
  assert(runId.length > 0, "textContainsWorkflowResultPayload: runId is required");
  if (!text.includes(WORKFLOW_RESULT_MESSAGE_OPENING_SENTENCE)) {
    return false;
  }
  const blockPattern = new RegExp(
    `<${WORKFLOW_RESULT_XML_TAG}>\\n([\\s\\S]*?)\\n</${WORKFLOW_RESULT_XML_TAG}>`,
    "g"
  );
  for (const match of text.matchAll(blockPattern)) {
    let payload: unknown;
    try {
      payload = JSON.parse(match[1] ?? "");
    } catch {
      continue;
    }
    if (!isRecordValue(payload)) {
      continue;
    }
    const workflow = payload.workflow;
    if (isRecordValue(workflow) && workflow.runId === runId) {
      return true;
    }
  }
  return false;
}

export interface WorkflowRunCardInput {
  scriptPath?: string;
  scriptSource?: string;
  /** Legacy persisted/test fixtures may still identify old named workflow invocations. */
  name?: string;
  args: unknown;
}

export interface WorkflowRunCardResult {
  runId: string;
  status: string;
  result: unknown;
  run?: WorkflowRunRecord;
}

type WorkflowRunToolPart = Extract<MuxMessage["parts"][number], { type: "dynamic-tool" }>;

export function isWorkflowTriggerDisplayMessage(message: MuxMessage): boolean {
  return message.metadata?.muxMetadata?.type === WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE;
}

export function isWorkflowRunCardDisplayMessage(message: MuxMessage): boolean {
  return message.metadata?.muxMetadata?.type === WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE;
}

export function isWorkflowResultMessage(message: Pick<MuxMessage, "metadata">): boolean {
  return message.metadata?.muxMetadata?.type === WORKFLOW_RESULT_METADATA_TYPE;
}

export function isWorkflowDisplayOnlyMessage(message: MuxMessage): boolean {
  return isWorkflowTriggerDisplayMessage(message) || isWorkflowRunCardDisplayMessage(message);
}

export function filterWorkflowDisplayOnlyMessages(messages: MuxMessage[]): MuxMessage[] {
  if (!messages.some(isWorkflowDisplayOnlyMessage)) {
    return messages;
  }
  return messages.filter((message) => !isWorkflowDisplayOnlyMessage(message));
}

export function buildWorkflowRunToolPart(
  input: WorkflowRunCardInput,
  result: WorkflowRunCardResult,
  now = Date.now()
): WorkflowRunToolPart {
  const scriptPath = input.scriptPath ?? input.name;
  const hasPath = scriptPath != null && scriptPath.length > 0;
  const hasSource = input.scriptSource != null && input.scriptSource.length > 0;
  assert(
    hasPath !== hasSource,
    "buildWorkflowRunToolPart: provide exactly one workflow scriptPath or scriptSource"
  );
  assert(result.runId.length > 0, "buildWorkflowRunToolPart: runId is required");

  return {
    type: "dynamic-tool",
    toolCallId: `workflow-run-${result.runId}`,
    toolName: "workflow_run",
    state: "output-available",
    input: {
      ...(hasPath ? { script_path: scriptPath } : { script_source: input.scriptSource }),
      args: input.args,
      run_in_background: true,
    },
    output: {
      status: result.status,
      runId: result.runId,
      result: result.result,
      ...(result.run != null ? { run: result.run } : {}),
    },
    timestamp: now,
  };
}

export function buildWorkflowRunCardMessage(
  input: WorkflowRunCardInput,
  result: WorkflowRunCardResult,
  now = Date.now()
): MuxMessage {
  const toolPart = buildWorkflowRunToolPart(input, result, now);
  return {
    id: toolPart.toolCallId,
    role: "assistant",
    parts: [toolPart],
    metadata: {
      historySequence: Number.MAX_SAFE_INTEGER,
      timestamp: now,
    },
  };
}
