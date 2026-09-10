import type {
  MuxTextPart,
  MuxReasoningPart,
  MuxFilePart,
  MuxToolPart,
} from "@/common/types/message";
import type { TodoItem } from "@/common/types/tools";

/** Part type for message construction */
type MuxPart = MuxTextPart | MuxReasoningPart | MuxFilePart | MuxToolPart;

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL CALL FACTORY
// ═══════════════════════════════════════════════════════════════════════════════
export function createFileReadTool(toolCallId: string, filePath: string, content: string): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "file_read",
    state: "output-available",
    input: { path: filePath },
    output: { success: true, content },
  };
}

export function createFileEditTool(toolCallId: string, filePath: string, diff: string): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "file_edit_replace_string",
    state: "output-available",
    input: { path: filePath, old_string: "...", new_string: "..." },
    output: { success: true, diff, edits_applied: 1 },
  };
}

export function createBashTool(
  toolCallId: string,
  script: string,
  output: string,
  exitCode = 0,
  timeoutSecs = 3,
  durationMs = 50,
  displayName = "Bash"
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "bash",
    state: "output-available",
    input: {
      script,
      run_in_background: false,
      timeout_secs: timeoutSecs,
      display_name: displayName,
    },
    output: { success: exitCode === 0, output, exitCode, wall_duration_ms: durationMs },
  };
}

export function createWebSearchTool(
  toolCallId: string,
  query: string,
  resultCount = 5,
  encrypted = true
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "web_search",
    state: "output-available",
    input: { query },
    output: encrypted
      ? Array.from({ length: resultCount }, () => ({ encryptedContent: "base64data..." }))
      : [{ title: "Example Result", url: "https://example.com", snippet: "A sample snippet" }],
  };
}

export function createTerminalTool(
  toolCallId: string,
  command: string,
  output: string,
  exitCode = 0
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "run_terminal_cmd",
    state: "output-available",
    input: { command, explanation: "Running command" },
    output: { success: exitCode === 0, stdout: output, exitCode },
  };
}

export function createTodoWriteTool(
  toolCallId: string,
  todosOrMessage: TodoItem[] | string,
  status: TodoItem["status"] = "in_progress"
): MuxPart {
  const todos =
    typeof todosOrMessage === "string" ? [{ content: todosOrMessage, status }] : todosOrMessage;

  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "todo_write",
    state: "output-available",
    input: { todos },
    output: { success: true, count: todos.length },
  };
}

export function createPendingTool(toolCallId: string, toolName: string, args: object): MuxPart {
  // Note: "input-available" is used for in-progress tool calls that haven't completed yet
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName,
    state: "input-available",
    input: args,
  };
}

/** Create a generic tool call with custom name, args, and output - falls back to GenericToolCall */

/** Create an agent_skill_read tool call */
export function createAgentSkillReadTool(
  toolCallId: string,
  skillName: string,
  opts: {
    description?: string;
    scope?: "project" | "global" | "built-in";
    body?: string;
  } = {}
): MuxPart {
  const scope = opts.scope ?? "project";
  const description = opts.description ?? `${skillName} skill description`;
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "agent_skill_read",
    state: "output-available",
    input: { name: skillName },
    output: {
      success: true,
      skill: {
        scope,
        directoryName: skillName,
        frontmatter: {
          name: skillName,
          description,
        },
        body: opts.body ?? `# ${skillName}\n\nSkill content here.`,
      },
    },
  };
}

export function createGenericTool(
  toolCallId: string,
  toolName: string,
  input: object,
  output: object
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName,
    state: "output-available",
    input,
    output,
  };
}

/** Create a propose_plan tool call with markdown plan content */
export function createProposePlanTool(
  toolCallId: string,
  planContent: string,
  planPath = ".mux/plan.md"
): MuxPart {
  // Extract title from first heading
  const titleMatch = /^#\s+(.+)$/m.exec(planContent);
  const title = titleMatch ? titleMatch[1] : "Plan";

  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "propose_plan",
    state: "output-available",
    input: { title, plan: planContent },
    output: {
      success: true,
      planPath,
      planContent, // Include for story rendering
      message: `Plan saved to ${planPath}`,
    },
  };
}

/** Create a completed task tool call with report */
export function createCompletedTaskTool(
  toolCallId: string,
  opts: {
    subagent_type: "explore" | "exec";
    prompt: string;
    title: string;
    taskId?: string;
    reportMarkdown: string;
    reportTitle?: string;
  }
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "task",
    state: "output-available",
    input: {
      subagent_type: opts.subagent_type,
      prompt: opts.prompt,
      title: opts.title,
      run_in_background: false,
    },
    output: {
      status: "completed",
      taskId: opts.taskId,
      reportMarkdown: opts.reportMarkdown,
      title: opts.reportTitle,
    },
  };
}

/** Create a task_await tool call */
export function createTaskAwaitTool(
  toolCallId: string,
  opts: {
    task_ids?: string[];
    timeout_secs?: number;
    results: Array<{
      taskId: string;
      status: "completed" | "queued" | "running" | "awaiting_report" | "not_found" | "error";
      reportMarkdown?: string;
      title?: string;
      error?: string;
      note?: string;
    }>;
  }
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "task_await",
    state: "output-available",
    input: {
      task_ids: opts.task_ids,
      timeout_secs: opts.timeout_secs,
    },
    output: {
      results: opts.results.map((r) => {
        if (r.status === "completed") {
          return {
            status: "completed" as const,
            taskId: r.taskId,
            reportMarkdown: r.reportMarkdown ?? "",
            title: r.title,
            note: r.note,
          };
        }
        if (r.status === "error") {
          return {
            status: "error" as const,
            taskId: r.taskId,
            error: r.error ?? "Unknown error",
          };
        }
        if (r.status === "queued" || r.status === "running" || r.status === "awaiting_report") {
          return {
            status: r.status,
            taskId: r.taskId,
            note: r.note,
          };
        }
        return {
          status: r.status,
          taskId: r.taskId,
        };
      }),
    },
  };
}
