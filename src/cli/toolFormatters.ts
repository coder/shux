/**
 * CLI tool output formatters for `xum run`
 *
 * Provides clean, readable formatting for recognized tool calls,
 * with emoji prefixes and structured output similar to the frontend UI.
 */

import { extractToolFilePath } from "@/common/utils/tools/toolInputFilePath";
import { formatDuration } from "../common/utils/formatDuration";
import { formatBytes } from "@/common/utils/formatBytes";
import chalk from "chalk";
import type { ToolCallStartEvent, ToolCallEndEvent } from "@/common/types/stream";
import type {
  BashToolArgs,
  BashToolResult,
  FileReadToolArgs,
  FileReadToolResult,
  FileEditReplaceStringToolResult,
  FileEditInsertToolResult,
  TaskToolArgs,
  TaskToolResult,
  WebFetchToolArgs,
  WebFetchToolResult,
} from "@/common/types/tools";

/** Tool formatters return formatted string or null to fall back to generic */
type ToolStartFormatter = (toolName: string, args: unknown) => string | null;
type ToolEndFormatter = (toolName: string, args: unknown, result: unknown) => string | null;

// ============================================================================
// Utilities
// ============================================================================

const TOOL_BLOCK_SEPARATOR = chalk.dim("─".repeat(40));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function extractFilePathArg(args: unknown): string | undefined {
  return extractToolFilePath(args);
}

function formatFilePath(filePath: string): string {
  return chalk.cyan(filePath);
}

function formatCommand(cmd: string): string {
  // Truncate long commands
  const maxLen = 80;
  const truncated = cmd.length > maxLen ? cmd.slice(0, maxLen) + "…" : cmd;
  return chalk.yellow(truncated);
}

function formatDiff(diff: string): string {
  // Color diff lines for terminal output
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return chalk.green(line);
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        return chalk.red(line);
      } else if (line.startsWith("@@")) {
        return chalk.cyan(line);
      }
      return line;
    })
    .join("\n");
}

function indent(text: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function renderUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractTaskIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (taskId): taskId is string => typeof taskId === "string" && taskId.length > 0
  );
}

function formatTaskIdSummary(taskIds: string[]): string {
  const preview = taskIds
    .slice(0, 3)
    .map((taskId) => chalk.dim(taskId))
    .join(", ");
  if (taskIds.length <= 3) {
    return preview;
  }
  return `${preview}${chalk.dim(` +${taskIds.length - 3} more`)}`;
}

// ============================================================================
// Tool Start Formatters
// ============================================================================

function formatFileEditStart(_toolName: string, args: unknown): string | null {
  const filePath = extractFilePathArg(args);
  if (!filePath) return null;

  return `✏️  ${formatFilePath(filePath)}`;
}

function formatFileReadStart(_toolName: string, args: unknown): string | null {
  const readArgs = args as FileReadToolArgs;
  const filePath = extractFilePathArg(args);
  if (!filePath) return null;

  let suffix = "";
  if (readArgs.offset != null || readArgs.limit != null) {
    const parts: string[] = [];
    if (readArgs.offset != null) parts.push(`L${readArgs.offset}`);
    if (readArgs.limit != null) parts.push(`+${readArgs.limit}`);
    suffix = chalk.dim(` (${parts.join(", ")})`);
  }

  return `📖 ${formatFilePath(filePath)}${suffix}`;
}

function formatBashStart(_toolName: string, args: unknown): string | null {
  const bashArgs = args as BashToolArgs;
  if (!bashArgs?.script) return null;

  const bg = bashArgs.run_in_background ? chalk.dim(" [background]") : "";
  const timeout = bashArgs.timeout_secs ? chalk.dim(` timeout:${bashArgs.timeout_secs}s`) : "";

  return `🔧 ${formatCommand(bashArgs.script)}${bg}${timeout}`;
}

function formatTaskStart(_toolName: string, args: unknown): string | null {
  const taskArgs = args as TaskToolArgs;
  if (!taskArgs?.title) return null;

  const bg = taskArgs.run_in_background ? chalk.dim(" [background]") : "";
  return `🤖 ${chalk.magenta(taskArgs.title)}${bg}`;
}

function formatWebFetchStart(_toolName: string, args: unknown): string | null {
  const fetchArgs = args as WebFetchToolArgs;
  if (!fetchArgs?.url) return null;

  return `🌐 ${chalk.blue(fetchArgs.url)}`;
}

function formatWebSearchStart(_toolName: string, args: unknown): string | null {
  const searchArgs = args as { query?: string };
  if (!searchArgs?.query) return null;

  return `🔍 ${chalk.blue(searchArgs.query)}`;
}

function formatTodoStart(_toolName: string, args: unknown): string | null {
  const todoArgs = args as { todos?: Array<{ content: string; status: string }> };
  if (!todoArgs?.todos) return null;

  return `📋 ${chalk.dim(`${todoArgs.todos.length} items`)}`;
}

function formatNotifyStart(_toolName: string, args: unknown): string | null {
  const notifyArgs = args as { title?: string };
  if (!notifyArgs?.title) return null;

  return `🔔 ${chalk.yellow(notifyArgs.title)}`;
}

function formatStatusSetStart(_toolName: string, args: unknown): string | null {
  const statusArgs = args as { emoji?: string; message?: string };
  if (!statusArgs?.message) return null;

  const emoji = statusArgs.emoji ?? "📌";
  return `${emoji} ${chalk.dim(statusArgs.message)}`;
}

function formatSetExitCodeStart(_toolName: string, args: unknown): string | null {
  const exitArgs = args as { exit_code?: number };
  if (exitArgs?.exit_code === undefined) return null;

  const code = exitArgs.exit_code;
  const color = code === 0 ? chalk.green : chalk.red;
  return `🚪 exit ${color(code)}`;
}

function formatAgentSkillReadStart(_toolName: string, args: unknown): string | null {
  const skillArgs = args as { name?: string };
  if (!skillArgs?.name) return null;

  return `📚 ${chalk.cyan(skillArgs.name)}`;
}

function formatCodeExecutionStart(_toolName: string, args: unknown): string | null {
  const codeArgs = args as { code?: string };
  if (!codeArgs?.code) return null;

  // Show first line or truncated preview of code
  const firstLine = codeArgs.code.split("\n")[0];
  const maxLen = 60;
  const preview = firstLine.length > maxLen ? firstLine.slice(0, maxLen) + "…" : firstLine;

  return `🧮 ${chalk.yellow(preview)}`;
}

// ============================================================================
// Tool End Formatters
// ============================================================================

function formatFileEditEnd(_toolName: string, _args: unknown, result: unknown): string | null {
  const editResult = result as FileEditReplaceStringToolResult | FileEditInsertToolResult;

  if (editResult?.success === false) {
    return `${chalk.red("✗")} ${chalk.red(editResult.error || "Edit failed")}`;
  }

  if (editResult?.success && editResult.diff) {
    return formatDiff(editResult.diff);
  }

  return chalk.green("✓");
}

function formatFileReadEnd(_toolName: string, _args: unknown, result: unknown): string | null {
  const readResult = result as FileReadToolResult;

  if (readResult?.success === false) {
    return `${chalk.red("✗")} ${chalk.red(readResult.error || "Read failed")}`;
  }

  if (readResult?.success) {
    const size = readResult.file_size ? chalk.dim(` (${formatBytes(readResult.file_size)})`) : "";
    const lines = readResult.lines_read ? chalk.dim(` ${readResult.lines_read} lines`) : "";
    return `${chalk.green("✓")}${lines}${size}`;
  }

  return null;
}

function formatBashEnd(_toolName: string, _args: unknown, result: unknown): string | null {
  if (!isRecord(result)) return null;
  const bashResult = result as BashToolResult;

  // Background process started
  if ("backgroundProcessId" in bashResult) {
    return `${chalk.blue("→")} background: ${chalk.dim(bashResult.backgroundProcessId)}`;
  }

  const duration = bashResult.wall_duration_ms
    ? chalk.dim(` (${formatDuration(bashResult.wall_duration_ms, "decimal")})`)
    : "";
  const exitCode = bashResult.exitCode;
  const exitStr = exitCode === 0 ? chalk.green("exit:0") : chalk.red(`exit:${exitCode}`);

  let output = `${exitStr}${duration}`;

  // Show truncated output if present
  if (bashResult.output) {
    const lines = bashResult.output.split("\n");
    const maxLines = 20;
    const truncated = lines.length > maxLines;
    const displayLines = truncated ? lines.slice(0, maxLines) : lines;
    const outputText = displayLines.join("\n");

    if (outputText.trim()) {
      output += "\n" + indent(chalk.dim(outputText));
      if (truncated) {
        output += "\n" + indent(chalk.dim(`... ${lines.length - maxLines} more lines`));
      }
    }
  }

  // Show error if present (only on failure)
  if (!bashResult.success && bashResult.error) {
    output += "\n" + indent(chalk.red(bashResult.error));
  }

  return output;
}

function formatTaskEnd(_toolName: string, _args: unknown, result: unknown): string | null {
  if (!isRecord(result)) return null;
  const taskResult = result as TaskToolResult;

  // Prefer showing the report for completed tasks.
  const status = (taskResult as { status?: unknown }).status;
  const taskId = (taskResult as { taskId?: unknown }).taskId;
  const reportMarkdown = (taskResult as { reportMarkdown?: unknown }).reportMarkdown;
  const taskIds = extractTaskIdArray((taskResult as { taskIds?: unknown }).taskIds);
  const reports = Array.isArray((taskResult as { reports?: unknown }).reports)
    ? ((taskResult as { reports?: Array<{ taskId?: unknown }> }).reports ?? [])
    : [];

  if (status === "completed" && typeof reportMarkdown === "string") {
    // Truncate long reports
    const maxLen = 500;
    const truncated =
      reportMarkdown.length > maxLen ? reportMarkdown.slice(0, maxLen) + "…" : reportMarkdown;
    const id = typeof taskId === "string" ? ` ${chalk.dim(taskId)}` : "";
    return `${chalk.green("✓")}${id}\n${indent(chalk.dim(truncated))}`;
  }

  if (status === "completed" && reports.length > 0) {
    const groupedTaskIds =
      taskIds.length > 0
        ? taskIds
        : reports
            .map((report) => report.taskId)
            .filter((reportTaskId): reportTaskId is string => typeof reportTaskId === "string");
    const idSummary = groupedTaskIds.length > 0 ? ` ${formatTaskIdSummary(groupedTaskIds)}` : "";
    const reportCount = `${reports.length} report${reports.length === 1 ? "" : "s"}`;
    return `${chalk.green("✓")} ${reportCount}${idSummary}`;
  }

  if ((status === "queued" || status === "running") && typeof taskId === "string") {
    return `${chalk.blue("→")} ${status}: ${chalk.dim(taskId)}`;
  }

  if ((status === "queued" || status === "running") && taskIds.length > 0) {
    return `${chalk.blue("→")} ${status}: ${formatTaskIdSummary(taskIds)}`;
  }

  return null;
}

function formatWebFetchEnd(_toolName: string, _args: unknown, result: unknown): string | null {
  if (result == null || typeof result !== "object") return null;

  // Unwrap SDK JSON-wrapper shape: { type: "json", value: ... }
  const maybeWrapped = result as Record<string, unknown>;
  const unwrapped =
    maybeWrapped.type === "json" && "value" in maybeWrapped ? maybeWrapped.value : result;

  if (unwrapped == null || typeof unwrapped !== "object") return null;
  const r = unwrapped as Record<string, unknown>;

  // Anthropic-native success: { type: "web_fetch_result", url, content: { title, source } }
  if (r.type === "web_fetch_result") {
    const content = r.content as Record<string, unknown> | undefined;
    const title = typeof content?.title === "string" ? chalk.dim(` "${content.title}"`) : "";
    const source = content?.source as Record<string, unknown> | undefined;
    const len =
      typeof source?.data === "string" ? chalk.dim(` ${formatBytes(source.data.length)}`) : "";
    return `${chalk.green("✓")}${title}${len}`;
  }

  // Anthropic-native error: { type: "web_fetch_tool_result_error", errorCode }
  if (r.type === "web_fetch_tool_result_error") {
    const errorCode = typeof r.errorCode === "string" ? r.errorCode : "fetch error";
    return `${chalk.red("✗")} ${chalk.red(errorCode)}`;
  }

  // Built-in format: { success: boolean, title?, content?, length?, error? }
  const fetchResult = unwrapped as WebFetchToolResult;
  if (fetchResult?.success === false) {
    return `${chalk.red("✗")} ${chalk.red(fetchResult.error ?? "Fetch failed")}`;
  }
  if (fetchResult?.success) {
    const title = fetchResult.title ? chalk.dim(` "${fetchResult.title}"`) : "";
    const len = fetchResult.length ? chalk.dim(` ${formatBytes(fetchResult.length)}`) : "";
    return `${chalk.green("✓")}${title}${len}`;
  }

  return null;
}

function formatCodeExecutionEnd(_toolName: string, _args: unknown, result: unknown): string | null {
  if (result === undefined || result === null) return null;

  // Code execution results can be complex - show truncated summary
  const resultStr = typeof result === "string" ? result : renderUnknown(result);
  const lines = resultStr.split("\n");
  const maxLines = 10;
  const truncated = lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;

  let output = chalk.green("✓");
  if (displayLines.join("").trim()) {
    output += "\n" + indent(chalk.dim(displayLines.join("\n")));
    if (truncated) {
      output += "\n" + indent(chalk.dim(`... ${lines.length - maxLines} more lines`));
    }
  }
  return output;
}

/** Simple success/error marker for inline tools that don't need detailed result formatting */
function formatSimpleSuccessEnd(_toolName: string, _args: unknown, result: unknown): string | null {
  // Check for error results
  const resultObj = result as { success?: boolean; error?: string } | null | undefined;
  if (resultObj?.success === false) {
    return `${chalk.red("✗")} ${chalk.red(resultObj.error ?? "Failed")}`;
  }
  return chalk.green("✓");
}

// ============================================================================
// Registry and Public API
// ============================================================================

interface ToolFormatterBinding {
  start?: ToolStartFormatter;
  end?: ToolEndFormatter;
  multilineResult?: true;
}

const toolFormatters: Record<string, ToolFormatterBinding> = {
  file_edit_replace_string: {
    start: formatFileEditStart,
    end: formatFileEditEnd,
    multilineResult: true,
  },
  file_edit_replace_lines: {
    start: formatFileEditStart,
    end: formatFileEditEnd,
    multilineResult: true,
  },
  file_edit_insert: { start: formatFileEditStart, end: formatFileEditEnd, multilineResult: true },
  file_read: { start: formatFileReadStart, end: formatFileReadEnd },
  bash: { start: formatBashStart, end: formatBashEnd, multilineResult: true },
  task: { start: formatTaskStart, end: formatTaskEnd, multilineResult: true },
  task_await: { end: formatTaskEnd, multilineResult: true },
  web_fetch: { start: formatWebFetchStart, end: formatWebFetchEnd },
  web_search: { start: formatWebSearchStart, end: formatSimpleSuccessEnd },
  todo_write: { start: formatTodoStart, end: formatSimpleSuccessEnd },
  notify: { start: formatNotifyStart, end: formatSimpleSuccessEnd },
  status_set: { start: formatStatusSetStart, end: formatSimpleSuccessEnd },
  set_exit_code: { start: formatSetExitCodeStart, end: formatSimpleSuccessEnd },
  agent_skill_read: { start: formatAgentSkillReadStart, end: formatSimpleSuccessEnd },
  agent_skill_read_file: { start: formatAgentSkillReadStart, end: formatSimpleSuccessEnd },
  code_execution: {
    start: formatCodeExecutionStart,
    end: formatCodeExecutionEnd,
    multilineResult: true,
  },
};

/**
 * Format a tool-call-start event for CLI output.
 * Returns formatted string, or null to use generic fallback.
 */
export function formatToolStart(payload: ToolCallStartEvent): string | null {
  const formatter = toolFormatters[payload.toolName]?.start;
  if (!formatter) return null;

  try {
    return formatter(payload.toolName, payload.args);
  } catch {
    return null;
  }
}

/**
 * Format a tool-call-end event for CLI output.
 * Returns formatted string, or null to use generic fallback.
 */
export function formatToolEnd(payload: ToolCallEndEvent, startArgs?: unknown): string | null {
  const formatter = toolFormatters[payload.toolName]?.end;
  if (!formatter) return null;

  try {
    return formatter(payload.toolName, startArgs, payload.result);
  } catch {
    return null;
  }
}

/**
 * Generic fallback formatter for unrecognized tools.
 */
export function formatGenericToolStart(payload: ToolCallStartEvent): string {
  return [
    TOOL_BLOCK_SEPARATOR,
    `${chalk.bold(payload.toolName)} ${chalk.dim(`(${payload.toolCallId})`)}`,
    chalk.dim("Args:"),
    indent(renderUnknown(payload.args)),
    TOOL_BLOCK_SEPARATOR,
  ].join("\n");
}

/**
 * Generic fallback formatter for unrecognized tool results.
 */
export function formatGenericToolEnd(payload: ToolCallEndEvent): string {
  return [
    TOOL_BLOCK_SEPARATOR,
    `${chalk.bold(payload.toolName)} ${chalk.dim("result")}`,
    indent(renderUnknown(payload.result)),
    TOOL_BLOCK_SEPARATOR,
  ].join("\n");
}

/**
 * Check if a tool should have its result on a new line (multi-line output).
 * For single-line results (file_read, web_fetch, etc.), result appears inline.
 */
export function isMultilineResultTool(toolName: string): boolean {
  return toolFormatters[toolName]?.multilineResult === true;
}
