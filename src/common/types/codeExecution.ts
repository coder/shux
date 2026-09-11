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
  /**
   * Provenance stamp for the routed-request consent scan: a nested
   * agent_skill_read(_file) in this execution — or, in kernel mode, an
   * earlier one on the same persistent mount, whose vars can still hold the
   * content — returned PROJECT-scope skill content. The guest can copy that
   * content anywhere in the output (return value, console), and kernel-mode
   * compaction may drop the nested record itself, so the whole output is
   * treated as project content wherever this is set.
   */
  carriesProjectSkillContent?: true;
}
