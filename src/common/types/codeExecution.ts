import type { ToolAttachmentPart } from "@/common/utils/attachments/toolAttachmentParts";

export interface CodeExecutionToolCallRecord {
  toolName: string;
  args: unknown;
  result?: unknown;
  error?: string;
  duration_ms: number;
  /** Kernel records suppress nested results into status and byte summaries. */
  ok?: boolean;
  bytes?: number;
}

export interface CodeExecutionConsoleRecord {
  level: "log" | "warn" | "error";
  args: unknown[];
  timestamp: number;
}

export interface CodeExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  toolCalls: CodeExecutionToolCallRecord[];
  consoleOutput: CodeExecutionConsoleRecord[];
  duration_ms: number;
  /** Original nested attachments carried for provider delivery and UI rendering. */
  attachments?: ToolAttachmentPart[];
}
