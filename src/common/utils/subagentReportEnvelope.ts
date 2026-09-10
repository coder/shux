import { THINKING_LEVELS, type ThinkingLevel } from "@/common/types/thinking";

export type SubagentReportStatus = "in_progress" | "completed";

export interface SubagentReportEnvelope {
  taskId: string;
  agentType: string;
  status: SubagentReportStatus;
  title: string;
  reportMarkdown: string;
  executionVersion?: string;
  executionId?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  structuredOutput?: unknown;
}

export const SUBAGENT_FAILURE_ENVELOPE_TAG = "<mux_subagent_failure>";

// Fallback titles for untitled reports; the matcher lives here so consumers (timeline dedupe) can
// treat them as absent titles without drifting from the builders.
export function subagentUpdateFallbackTitle(agentType: string): string {
  return `Subagent (${agentType}) update`;
}

export function subagentReportFallbackTitle(agentType: string): string {
  return `Subagent (${agentType}) report`;
}

export function isSubagentFallbackTitle(title: string): boolean {
  return /^Subagent \(.+\) (?:update|report)$/.test(title);
}

const ROOT_OPEN = "<mux_subagent_report>";
const ROOT_CLOSE = "</mux_subagent_report>";
const STRUCTURED_OUTPUT_START = "\n<structured_output_json>\n";
const STRUCTURED_OUTPUT_END = "\n</structured_output_json>";
const TITLE_REPORT_SEPARATOR = "</title>\n<report_markdown>\n";
const REPORT_END = "\n</report_markdown>";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStatus(value: unknown): value is SubagentReportStatus {
  return value === "in_progress" || value === "completed";
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * New reports use JSON framing so arbitrary Markdown and protocol examples round-trip exactly while
 * remaining readable to the parent model. The outer tag preserves the existing prompt contract.
 */
export function formatSubagentReportEnvelope(report: SubagentReportEnvelope): string {
  const json = JSON.stringify(report, null, 2);
  if (json === undefined) {
    throw new Error("Subagent report envelope must be JSON-serializable");
  }
  return `${ROOT_OPEN}\n${json}\n${ROOT_CLOSE}`;
}

function parseJsonEnvelope(inner: string): SubagentReportEnvelope | null {
  let value: unknown;
  try {
    value = JSON.parse(inner);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (
    !isNonEmptyString(record.taskId) ||
    !isNonEmptyString(record.agentType) ||
    !isStatus(record.status) ||
    !isNonEmptyString(record.title) ||
    !isNonEmptyString(record.reportMarkdown)
  ) {
    return null;
  }

  return {
    taskId: record.taskId,
    agentType: record.agentType,
    status: record.status,
    title: record.title,
    reportMarkdown: record.reportMarkdown,
    ...(isNonEmptyString(record.executionVersion)
      ? { executionVersion: record.executionVersion }
      : {}),
    ...(isNonEmptyString(record.executionId) ? { executionId: record.executionId } : {}),
    // Model/thinking are display metadata: tolerate absent or malformed values so a bad
    // producer can never invalidate an otherwise well-formed report.
    ...(isNonEmptyString(record.model) ? { model: record.model } : {}),
    ...(isThinkingLevel(record.thinkingLevel) ? { thinkingLevel: record.thinkingLevel } : {}),
    ...(Object.hasOwn(record, "structuredOutput")
      ? { structuredOutput: record.structuredOutput }
      : {}),
  };
}

function parseLegacyStructuredOutput(block: string | null): unknown {
  if (block === null) return undefined;
  const fenced = /^```json\s*\n([\s\S]*?)\n```$/.exec(block.trim());
  const json = fenced?.[1]?.trim() ?? block.trim();
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

/** Best-effort compatibility for reports persisted before JSON framing was introduced. */
function parseLegacyEnvelope(inner: string): SubagentReportEnvelope | null {
  let reportEnvelope = inner;
  let structuredOutputBlock: string | null = null;
  if (inner.endsWith(STRUCTURED_OUTPUT_END)) {
    const start = inner.lastIndexOf(STRUCTURED_OUTPUT_START);
    if (start !== -1) {
      reportEnvelope = inner.slice(0, start);
      structuredOutputBlock = inner
        .slice(start + STRUCTURED_OUTPUT_START.length, -STRUCTURED_OUTPUT_END.length)
        .trim();
    }
  }
  if (!reportEnvelope.endsWith(REPORT_END)) return null;

  const body = reportEnvelope.slice(0, -REPORT_END.length);
  // Legacy framing cannot distinguish delimiter text in both title and Markdown. Favor the first
  // separator so historical report bodies that document the protocol remain intact.
  const reportStart = body.indexOf(TITLE_REPORT_SEPARATOR);
  if (reportStart === -1) return null;

  const fields =
    /^<task_id>([^\n]*)<\/task_id>\n<agent_type>([^\n]*)<\/agent_type>\n(?:<status>([^\n]*)<\/status>\n)?<title>([\s\S]*)$/.exec(
      body.slice(0, reportStart)
    );
  if (!fields) return null;

  const taskId = fields[1]?.trim();
  const agentType = fields[2]?.trim();
  const rawStatus = fields[3]?.trim() || "completed";
  const title = fields[4]?.replace(/\s+/g, " ").trim();
  const reportMarkdown = body.slice(reportStart + TITLE_REPORT_SEPARATOR.length);
  if (!taskId || !agentType || !isStatus(rawStatus) || !title || reportMarkdown.length === 0) {
    return null;
  }

  const structuredOutput = parseLegacyStructuredOutput(structuredOutputBlock);
  return {
    taskId,
    agentType,
    status: rawStatus,
    title,
    reportMarkdown,
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
  };
}

export function parseSubagentReportEnvelope(content: string): SubagentReportEnvelope | null {
  const root = /^<mux_subagent_report>\n([\s\S]*)\n<\/mux_subagent_report>$/.exec(content);
  if (!root) return null;
  return parseJsonEnvelope(root[1]) ?? parseLegacyEnvelope(root[1]);
}

export function isCompletedSubagentReportEnvelope(content: string): boolean {
  return parseSubagentReportEnvelope(content)?.status === "completed";
}
