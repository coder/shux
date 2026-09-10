import { z } from "zod";
import { RUNTIME_MODE } from "@/common/types/runtime";
import {
  buildTaskToolAgentArgsSchema,
  buildTaskToolDescription,
  getAvailableTools,
  supportsGoogleNativeToolsWithFunctionTools,
  TaskToolArgsSchema,
  TaskRetitleToolArgsSchema,
  TaskWorkspaceLifecycleToolArgsSchema,
  TaskWorkspaceLifecycleToolInputSchema,
  TOOL_DEFINITIONS,
  WorkflowRunToolArgsSchema,
} from "./toolDefinitions";

describe("TOOL_DEFINITIONS", () => {
  it("only advertises intuition with both recall and memory enabled, never its internal tools", () => {
    for (const enableMemory of [false, true]) {
      for (const enableIntuition of [false, true]) {
        const tools = getAvailableTools("openai:test", { enableMemory, enableIntuition });
        expect(tools.includes("intuition")).toBe(enableMemory && enableIntuition);
        expect(tools).not.toContain("memory_read");
        expect(tools).not.toContain("intuition_report");
      }
    }
  });

  it("bounds intuition cues and confidence reports without requiring evidence for uncertain leads", () => {
    expect(TOOL_DEFINITIONS.intuition.schema.safeParse({ cue: "" }).success).toBe(false);
    expect(TOOL_DEFINITIONS.intuition.schema.safeParse({ cue: "x".repeat(2001) }).success).toBe(
      false
    );
    expect(TOOL_DEFINITIONS.intuition.schema.safeParse({ cue: "Relevant task" }).success).toBe(
      true
    );
    const item = {
      path: "/memories/global/test.md",
      relevance: 0.5,
      excerpt: "",
      why: "Potential lead",
    };
    expect(TOOL_DEFINITIONS.intuition_report.schema.safeParse({ items: [item] }).success).toBe(
      true
    );
    expect(
      TOOL_DEFINITIONS.intuition_report.schema.safeParse({ items: [{ ...item, relevance: 1.1 }] })
        .success
    ).toBe(false);
    expect(
      TOOL_DEFINITIONS.intuition_report.schema.safeParse({
        items: Array.from({ length: 7 }, () => item),
      }).success
    ).toBe(false);
  });

  it("accepts custom subagent_type IDs (deprecated alias)", () => {
    const parsed = TaskToolArgsSchema.safeParse({
      subagent_type: "potato",
      prompt: "do the thing",
      title: "Test",
      run_in_background: true,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.subagent_type).toBe("potato");
    }
  });

  it("requires a nonblank friendly title when retitling a persistent child", () => {
    expect(
      TaskRetitleToolArgsSchema.safeParse({ task_id: "child", title: "Reviewer" }).success
    ).toBe(true);
    expect(TaskRetitleToolArgsSchema.safeParse({ task_id: "child", title: "   " }).success).toBe(
      false
    );
  });

  it("leaves n unset for task tool calls when omitted", () => {
    const parsed = TaskToolArgsSchema.safeParse({
      subagent_type: "explore",
      prompt: "do the thing",
      title: "Test",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.n).toBeUndefined();
    }
  });

  it("accepts task tool best-of counts between 1 and 20", () => {
    expect(
      TaskToolArgsSchema.safeParse({
        subagent_type: "explore",
        prompt: "do the thing",
        title: "Test",
        n: 20,
      }).success
    ).toBe(true);

    expect(
      TaskToolArgsSchema.safeParse({
        subagent_type: "explore",
        prompt: "do the thing",
        title: "Test",
        n: 0,
      }).success
    ).toBe(false);

    expect(
      TaskToolArgsSchema.safeParse({
        subagent_type: "explore",
        prompt: "do the thing",
        title: "Test",
        n: 21,
      }).success
    ).toBe(false);
  });

  it("accepts workspace task args without an agent id", () => {
    const parsed = TaskToolArgsSchema.safeParse({
      kind: "workspace",
      prompt: "Summarize this repository",
      title: "Repository summary",
      run_in_background: true,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe("workspace");
      expect(parsed.data.agentId).toBeUndefined();
      expect(parsed.data.subagent_type).toBeUndefined();
    }
  });

  it("accepts workspace task args with an agent id", () => {
    const parsed = TaskToolArgsSchema.safeParse({
      kind: "workspace",
      agentId: "plan",
      prompt: "Plan a small change",
      title: "Plan dogfood",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.agentId).toBe("plan");
    }
  });

  it("still rejects subagent_type for workspace tasks", () => {
    const parsed = TaskToolArgsSchema.safeParse({
      kind: "workspace",
      subagent_type: "plan",
      prompt: "Plan a small change",
      title: "Plan dogfood",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["subagent_type"]);
    }
  });

  it("rejects workspace task fanout until workspace handles support it", () => {
    expect(
      TaskToolArgsSchema.safeParse({
        kind: "workspace",
        prompt: "Summarize this repository",
        title: "Repository summary",
        n: 2,
      }).success
    ).toBe(false);
  });

  it("validates task workspace lifecycle targets and optional nulls", () => {
    expect(
      TaskWorkspaceLifecycleToolArgsSchema.safeParse({
        action: "archive",
        targets: [{ taskId: "wst_child" }],
        interrupt_active: null,
        force: null,
        acknowledged_untracked_paths: null,
      }).success
    ).toBe(true);

    expect(
      TaskWorkspaceLifecycleToolArgsSchema.safeParse({
        action: "delete_worktree",
        targets: [{ workspaceId: "child-workspace" }],
      }).success
    ).toBe(true);

    expect(
      TaskWorkspaceLifecycleToolArgsSchema.safeParse({
        action: "remove",
        targets: [{ taskId: "wst_child", workspaceId: "child-workspace" }],
      }).success
    ).toBe(false);

    expect(
      TaskWorkspaceLifecycleToolArgsSchema.safeParse({
        action: "archive",
        targets: [{}],
      }).success
    ).toBe(false);

    expect(
      TaskWorkspaceLifecycleToolArgsSchema.safeParse({
        action: "destroy",
        targets: [{ workspaceId: "child-workspace" }],
      }).success
    ).toBe(false);
  });

  it("restricts live task_workspace_lifecycle input to reversible actions", () => {
    expect(
      TaskWorkspaceLifecycleToolInputSchema.safeParse({
        action: "archive",
        targets: [{ taskId: "wst_child" }],
        interrupt_active: null,
        acknowledged_untracked_paths: null,
      }).success
    ).toBe(true);

    expect(
      TaskWorkspaceLifecycleToolInputSchema.safeParse({
        action: "unarchive",
        targets: [{ workspaceId: "child-workspace" }],
      }).success
    ).toBe(true);

    // Irreversible verbs and their escape hatch must not be model-invocable through
    // this tool; task_remove is the only irreversible verb.
    expect(
      TaskWorkspaceLifecycleToolInputSchema.safeParse({
        action: "delete_worktree",
        targets: [{ workspaceId: "child-workspace" }],
      }).success
    ).toBe(false);

    expect(
      TaskWorkspaceLifecycleToolInputSchema.safeParse({
        action: "remove",
        targets: [{ workspaceId: "child-workspace" }],
      }).success
    ).toBe(false);

    expect(
      TaskWorkspaceLifecycleToolInputSchema.safeParse({
        action: "archive",
        targets: [{ workspaceId: "child-workspace" }],
        force: true,
      }).success
    ).toBe(false);
  });

  it("requires workspaceId for existing workspace task targets", () => {
    expect(
      TaskToolArgsSchema.safeParse({
        kind: "workspace",
        prompt: "Continue in that workspace",
        title: "Follow-up",
        workspace: { mode: "existing" },
      }).success
    ).toBe(false);

    expect(
      TaskToolArgsSchema.safeParse({
        kind: "workspace",
        prompt: "Continue in that workspace",
        title: "Follow-up",
        workspace: { mode: "existing", workspaceId: "child-workspace" },
      }).success
    ).toBe(true);
  });

  it("accepts bash tool calls using command (alias for script)", () => {
    const parsed = TOOL_DEFINITIONS.bash.schema.safeParse({
      command: "ls",
      timeout_secs: 60,
      run_in_background: false,
      display_name: "Test",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.script).toBe("ls");
      expect("command" in parsed.data).toBe(false);
    }
  });

  it("accepts bash tool calls with model_intent", () => {
    const parsed = TOOL_DEFINITIONS.bash.schema.safeParse({
      script: "ls",
      model_intent: "Checking repository state",
      timeout_secs: 60,
      run_in_background: false,
      display_name: "Test",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.model_intent).toBe("Checking repository state");
    }
  });

  it("accepts bash tool calls without model_intent", () => {
    const parsed = TOOL_DEFINITIONS.bash.schema.safeParse({
      script: "ls",
      timeout_secs: 60,
      run_in_background: false,
      display_name: "Test",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.model_intent).toBeUndefined();
    }
  });

  it("accepts bash tool calls with null model_intent", () => {
    const parsed = TOOL_DEFINITIONS.bash.schema.safeParse({
      script: "ls",
      model_intent: null,
      timeout_secs: 60,
      run_in_background: false,
      display_name: "Test",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.model_intent).toBeNull();
    }
  });

  it("prefers script when both script and command are provided", () => {
    const parsed = TOOL_DEFINITIONS.bash.schema.safeParse({
      script: "echo hi",
      command: "ls",
      timeout_secs: 60,
      run_in_background: false,
      display_name: "Test",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.script).toBe("echo hi");
    }
  });

  it("rejects bash tool calls missing both script and command", () => {
    const parsed = TOOL_DEFINITIONS.bash.schema.safeParse({
      timeout_secs: 60,
      run_in_background: false,
      display_name: "Test",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts bash tool calls using description (alias for display_name)", () => {
    // DeepSeek v4 emits `description` instead of `display_name`; ensure it normalizes.
    const parsed = TOOL_DEFINITIONS.bash.schema.safeParse({
      script: "ls",
      timeout_secs: 60,
      run_in_background: false,
      description: "List files",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.display_name).toBe("List files");
      expect("description" in parsed.data).toBe(false);
    }
  });

  it("prefers display_name when both display_name and description are provided", () => {
    const parsed = TOOL_DEFINITIONS.bash.schema.safeParse({
      script: "ls",
      timeout_secs: 60,
      run_in_background: false,
      display_name: "Real Name",
      description: "Alias Name",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.display_name).toBe("Real Name");
    }
  });

  it("validates heartbeat tool configuration bounds", () => {
    expect(TOOL_DEFINITIONS.heartbeat.schema.safeParse({ action: "get" }).success).toBe(true);
    expect(
      TOOL_DEFINITIONS.heartbeat.schema.safeParse({
        action: "set",
        enabled: true,
        intervalMs: 5 * 60 * 1000,
        contextMode: "compact",
      }).success
    ).toBe(true);
    expect(
      TOOL_DEFINITIONS.heartbeat.schema.safeParse({
        action: "set",
        intervalMs: 60 * 1000,
      }).success
    ).toBe(false);
    expect(
      TOOL_DEFINITIONS.heartbeat.schema.safeParse({
        action: "configure",
      }).success
    ).toBe(false);
  });

  it("validates set_goal required and optional fields", () => {
    const schema = TOOL_DEFINITIONS.set_goal.schema;

    expect(schema.safeParse({ objective: "Ship it" }).success).toBe(true);
    expect(schema.safeParse({ objective: "" }).success).toBe(false);
    expect(schema.safeParse({ objective: "   " }).success).toBe(false);
    expect(schema.safeParse({ objective: "Ship it", budgetCents: 1 }).success).toBe(true);
    expect(schema.safeParse({ objective: "Ship it", budgetCents: 0 }).success).toBe(false);
    expect(schema.safeParse({ objective: "Ship it", budgetCents: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ objective: "Ship it", turnCap: 1 }).success).toBe(true);
    expect(schema.safeParse({ objective: "Ship it", turnCap: 0 }).success).toBe(false);
    expect(
      schema.safeParse({
        objective: "Ship it",
        expectedGoalId: "11111111-1111-4111-8111-111111111111",
      }).success
    ).toBe(true);
    expect(schema.safeParse({ objective: "Ship it", expectedGoalId: "not-a-uuid" }).success).toBe(
      false
    );
    expect(schema.safeParse({ objective: "Ship it", workspaceId: "other" }).success).toBe(false);
  });

  it("requires complete_goal summary", () => {
    expect(TOOL_DEFINITIONS.complete_goal.schema.safeParse({}).success).toBe(false);
    expect(TOOL_DEFINITIONS.complete_goal.schema.safeParse({ summary: "Done." }).success).toBe(
      true
    );
  });

  it("exposes complete_goal as the single completion path only", () => {
    const parsed = TOOL_DEFINITIONS.complete_goal.schema.safeParse({
      summary: "Done.",
      status: "paused",
    });

    expect(parsed.success).toBe(false);
  });

  const filePathAliasCases = [
    {
      toolName: "file_read",
      args: {
        offset: 1,
        limit: 10,
      },
    },
    {
      toolName: "file_edit_replace_string",
      args: {
        old_string: "before",
        new_string: "after",
      },
    },
    {
      toolName: "file_edit_replace_lines",
      args: {
        start_line: 1,
        end_line: 1,
        new_lines: ["line"],
      },
    },
    {
      toolName: "file_edit_insert",
      args: {
        insert_after: "marker",
        content: "text",
      },
    },
  ] as const;

  it.each(filePathAliasCases)(
    "accepts file_path alias for $toolName and normalizes to path",
    ({ toolName, args }) => {
      const parsed = TOOL_DEFINITIONS[toolName].schema.safeParse({
        ...args,
        file_path: "src/example.ts",
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.path).toBe("src/example.ts");
        expect("file_path" in parsed.data).toBe(false);
      }
    }
  );

  it.each(filePathAliasCases)(
    "prefers canonical path over file_path for $toolName",
    ({ toolName, args }) => {
      const parsed = TOOL_DEFINITIONS[toolName].schema.safeParse({
        ...args,
        path: "src/canonical.ts",
        file_path: "src/legacy.ts",
      });

      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.path).toBe("src/canonical.ts");
        expect("file_path" in parsed.data).toBe(false);
      }
    }
  );

  it.each(filePathAliasCases)(
    "rejects $toolName when path is present but invalid, even if file_path is provided",
    ({ toolName, args }) => {
      const parsed = TOOL_DEFINITIONS[toolName].schema.safeParse({
        ...args,
        path: 123,
        file_path: "src/fallback.ts",
      });

      expect(parsed.success).toBe(false);
    }
  );

  it.each(filePathAliasCases)(
    "rejects $toolName calls missing both path and file_path",
    ({ toolName, args }) => {
      const parsed = TOOL_DEFINITIONS[toolName].schema.safeParse(args);
      expect(parsed.success).toBe(false);
    }
  );

  it("accepts an optional advisor question and encourages passing one", () => {
    expect(TOOL_DEFINITIONS.advisor.schema.safeParse({}).success).toBe(true);
    expect(TOOL_DEFINITIONS.advisor.schema.safeParse({ question: null }).success).toBe(true);

    const parsed = TOOL_DEFINITIONS.advisor.schema.safeParse({
      question: "Should we split this refactor into smaller commits?",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.question).toBe("Should we split this refactor into smaller commits?");
    }
  });

  it("dispatches task tool description on runtime mode", () => {
    // Different runtimes give the agent different visibility guidance for whether
    // sub-agents see uncommitted parent changes, so the function must actually
    // branch on runtimeMode rather than collapse to a single string.
    expect(buildTaskToolDescription(RUNTIME_MODE.LOCAL)).not.toBe(
      buildTaskToolDescription(RUNTIME_MODE.WORKTREE)
    );
  });

  it("accepts workspace turn queue dispatch mode", () => {
    const parsed = TOOL_DEFINITIONS.task.schema.safeParse({
      kind: "workspace",
      prompt: "follow up",
      title: "Follow-up",
      run_in_background: true,
      workspace: {
        mode: "existing",
        workspaceId: "child-workspace",
        queueDispatchMode: "turn-end",
      },
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.workspace?.queueDispatchMode).toBe("turn-end");
    }

    expect(
      TOOL_DEFINITIONS.task.schema.safeParse({
        kind: "workspace",
        prompt: "follow up",
        title: "Follow-up",
        workspace: {
          mode: "existing",
          workspaceId: "child-workspace",
          queueDispatchMode: "after-breakfast",
        },
      }).success
    ).toBe(false);
  });

  it("accepts sub-agent guidance dispatch modes and rejects blank guidance", () => {
    expect(
      TOOL_DEFINITIONS.task_send_message.schema.safeParse({
        task_id: "child-task",
        message: "Use the latest user correction.",
        queue_dispatch_mode: "turn-end",
      }).success
    ).toBe(true);
    expect(
      TOOL_DEFINITIONS.task_send_message.schema.safeParse({
        task_id: "child-task",
        message: "   ",
      }).success
    ).toBe(false);
  });

  describe("task tool isolation parameter", () => {
    const validArgs = { agentId: "explore", prompt: "investigate", title: "Investigate" };

    it("only advertises isolation on runtimes that can share the parent checkout", () => {
      // Worktree/SSH expose `isolation`; the (local) variant strips it so it never reaches the model.
      const withIsolation = buildTaskToolAgentArgsSchema({ includeIsolation: true });
      const withoutIsolation = buildTaskToolAgentArgsSchema({ includeIsolation: false });

      expect(withIsolation.safeParse({ ...validArgs, isolation: "none" }).success).toBe(true);
      // .strict() rejects the unknown key outright on the local variant.
      expect(withoutIsolation.safeParse({ ...validArgs, isolation: "none" }).success).toBe(false);
      // Both variants still accept args that omit isolation entirely.
      expect(withoutIsolation.safeParse(validArgs).success).toBe(true);
    });

    it("rejects unknown isolation modes", () => {
      const schema = buildTaskToolAgentArgsSchema({ includeIsolation: true });
      expect(schema.safeParse({ ...validArgs, isolation: "fork" }).success).toBe(true);
      expect(schema.safeParse({ ...validArgs, isolation: "sandbox" }).success).toBe(false);
    });

    it("documents the isolation option only for shareable runtimes", () => {
      for (const mode of [RUNTIME_MODE.WORKTREE, RUNTIME_MODE.SSH]) {
        expect(buildTaskToolDescription(mode)).toContain('isolation: "none"');
      }
      for (const mode of [RUNTIME_MODE.LOCAL, RUNTIME_MODE.DOCKER, RUNTIME_MODE.DEVCONTAINER]) {
        expect(buildTaskToolDescription(mode)).not.toContain('isolation: "none"');
      }
    });
  });

  it("accepts ask_user_question headers longer than 12 characters", () => {
    const parsed = TOOL_DEFINITIONS.ask_user_question.schema.safeParse({
      questions: [
        {
          question: "How should docs be formatted?",
          header: "Documentation",
          options: [
            { label: "Inline", description: "Explain in code comments" },
            { label: "Sections", description: "Separate markdown sections" },
          ],
          multiSelect: false,
        },
        {
          question: "Should we show error handling?",
          header: "Error Handling",
          options: [
            { label: "Minimal", description: "Let errors bubble" },
            { label: "Basic", description: "Catch common errors" },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects task(kind=bash) tool calls (bash is a separate tool)", () => {
    const parsed = TOOL_DEFINITIONS.task.schema.safeParse({
      // Legacy shape; should not validate against the current task schema.
      kind: "bash",
      script: "ls",
      timeout_secs: 100000,
      run_in_background: false,
    });

    expect(parsed.success).toBe(false);
  });

  it("always includes global skill management tools", () => {
    const tools = getAvailableTools("openai:gpt-4o");

    expect(tools).toContain("agent_skill_list");
    expect(tools).toContain("agent_skill_write");
    expect(tools).toContain("agent_skill_delete");
    expect(tools).toContain("mux_agents_read");
    expect(tools).toContain("mux_agents_write");
    expect(tools).toContain("mux_config_read");
    expect(tools).toContain("mux_config_write");
  });

  it("includes skills catalog tools", () => {
    const tools = getAvailableTools("openai:gpt-4o");

    expect(tools).toContain("skills_catalog_search");
    expect(tools).toContain("skills_catalog_read");
  });

  it("includes persistent child management tools", () => {
    const tools = getAvailableTools("openai:gpt-4o");

    expect(tools).toContain("task_send_message");
    expect(tools).toContain("task_retitle");
    expect(tools).toContain("task_stop");
    expect(tools).toContain("task_remove");
  });

  it("includes the workspace heartbeat tool", () => {
    const tools = getAvailableTools("openai:gpt-4o");

    expect(tools).toContain("heartbeat");
  });

  it("only includes Review pane tools when enableReviewPane is not disabled", () => {
    const defaultTools = getAvailableTools("openai:gpt-4o");
    expect(defaultTools).toContain("review_pane_update");
    expect(defaultTools).toContain("review_pane_get");

    const enabledTools = getAvailableTools("openai:gpt-4o", { enableReviewPane: true });
    expect(enabledTools).toContain("review_pane_update");
    expect(enabledTools).toContain("review_pane_get");

    // Sub-agents pass enableReviewPane: false so they can't pin code to the
    // user-facing parent Review pane.
    const subAgentTools = getAvailableTools("openai:gpt-4o", { enableReviewPane: false });
    expect(subAgentTools).not.toContain("review_pane_update");
    expect(subAgentTools).not.toContain("review_pane_get");
  });

  it("only includes mcp_prompt_get when enableMcpPromptGet is set", () => {
    expect(getAvailableTools("openai:gpt-4o")).not.toContain("mcp_prompt_get");
    expect(getAvailableTools("openai:gpt-4o", { enableMcpPromptGet: false })).not.toContain(
      "mcp_prompt_get"
    );
    expect(getAvailableTools("openai:gpt-4o", { enableMcpPromptGet: true })).toContain(
      "mcp_prompt_get"
    );
  });

  it("only includes tool_catalog_search when enableToolSearch is set", () => {
    // Off by default: the tool-search experiment must not leak into normal assembly.
    expect(getAvailableTools("openai:gpt-4o")).not.toContain("tool_catalog_search");
    expect(getAvailableTools("openai:gpt-4o", { enableToolSearch: false })).not.toContain(
      "tool_catalog_search"
    );

    expect(getAvailableTools("openai:gpt-4o", { enableToolSearch: true })).toContain(
      "tool_catalog_search"
    );
  });

  it("requires workflow_run calls to use exactly one launch source", () => {
    expect(
      WorkflowRunToolArgsSchema.safeParse({
        script_path: "skill://deep-research/workflow.js",
        args: { topic: "workflow tools" },
        run_in_background: false,
      }).success
    ).toBe(true);

    expect(
      WorkflowRunToolArgsSchema.safeParse({
        script_source: "export default function workflow() { return { reportMarkdown: 'ok' }; }",
        args: { topic: "workflow tools" },
        run_in_background: false,
      }).success
    ).toBe(true);

    const both = WorkflowRunToolArgsSchema.safeParse({
      script_path: "skill://deep-research/workflow.js",
      script_source: "export default function workflow() {}",
      args: { topic: "workflow tools" },
      run_in_background: false,
    });
    expect(both.success).toBe(false);
    expect(both.error?.issues.map((issue) => issue.message)).toContain(
      "Provide exactly one of script_path or script_source."
    );

    const neither = WorkflowRunToolArgsSchema.safeParse({
      args: { topic: "workflow tools" },
      run_in_background: false,
    });
    expect(neither.success).toBe(false);
    expect(neither.error?.issues.map((issue) => issue.message)).toContain(
      "Provide exactly one of script_path or script_source."
    );

    expect(
      WorkflowRunToolArgsSchema.safeParse({
        script_path: null,
        script_source: "export default function workflow() {}",
      }).success
    ).toBe(true);
    expect(
      WorkflowRunToolArgsSchema.safeParse({ script_path: null, script_source: null }).success
    ).toBe(false);

    expect(WorkflowRunToolArgsSchema.safeParse({ script_source: "" }).success).toBe(false);
    expect(
      WorkflowRunToolArgsSchema.safeParse({
        name: "deep-research",
        args: { topic: "workflow tools" },
        run_in_background: false,
      }).success
    ).toBe(false);
  });

  it("keeps workflow_run launch fields nullable in generated tool schemas", () => {
    const workflowSchema = z.toJSONSchema(WorkflowRunToolArgsSchema);
    const properties = workflowSchema.properties;
    const schemaHasAnyOfEntry = (schema: unknown, expected: Record<string, unknown>) => {
      if (schema == null || typeof schema !== "object") {
        return false;
      }
      const anyOf = (schema as { anyOf?: unknown }).anyOf;
      return (
        Array.isArray(anyOf) &&
        anyOf.some(
          (entry) =>
            entry != null &&
            typeof entry === "object" &&
            Object.entries(expected).every(
              ([key, value]) => (entry as Record<string, unknown>)[key] === value
            )
        )
      );
    };

    expect(schemaHasAnyOfEntry(properties?.script_path, { type: "string", minLength: 1 })).toBe(
      true
    );
    expect(schemaHasAnyOfEntry(properties?.script_path, { type: "null" })).toBe(true);
    expect(schemaHasAnyOfEntry(properties?.script_source, { type: "string", minLength: 1 })).toBe(
      true
    );
    expect(schemaHasAnyOfEntry(properties?.script_source, { type: "null" })).toBe(true);
    expect(workflowSchema.required).not.toContain("script_path");
    expect(workflowSchema.required).not.toContain("script_source");
  });

  it("only includes workflow tools when dynamic workflows are enabled", () => {
    const disabledTools = getAvailableTools("openai:gpt-4o", { enableDynamicWorkflows: false });
    expect(disabledTools).not.toContain("workflow_list");
    expect(disabledTools).not.toContain("workflow_read");
    expect(disabledTools).not.toContain("workflow_run");
    expect(disabledTools).not.toContain("workflow_resume");

    const enabledTools = getAvailableTools("openai:gpt-4o", { enableDynamicWorkflows: true });
    expect(enabledTools).not.toContain("workflow_list");
    expect(enabledTools).not.toContain("workflow_read");
    expect(enabledTools).toContain("workflow_run");
    expect(enabledTools).toContain("workflow_resume");
  });

  it("gates native Google tools to Gemini 3 models", () => {
    expect(getAvailableTools("google:gemini-2.5-pro")).not.toContain("google_search");
    expect(getAvailableTools("google:gemini-2.5-pro")).not.toContain("url_context");
    expect(getAvailableTools("google:gemini-4-pro")).not.toContain("google_search");
    expect(getAvailableTools("google:gemini-4-pro")).not.toContain("url_context");

    for (const modelString of [
      "google:gemini-3.1-pro-preview",
      "google:gemini-3.5-flash",
      "google:models/gemini-3.5-flash",
    ]) {
      const tools = getAvailableTools(modelString);
      expect(tools).toContain("google_search");
      expect(tools).toContain("url_context");
    }
  });

  it("exposes xAI native search tools only for frontier Grok", () => {
    for (const modelString of [
      "xai:grok-4.6",
      "xai:grok-4.6-latest",
      "xai:grok-4.5",
      "xai:grok-4.5-latest",
    ]) {
      expect(getAvailableTools(modelString)).toEqual(
        expect.arrayContaining(["web_search", "x_search"])
      );
    }
    expect(getAvailableTools("xai:grok-4-1-fast")).not.toContain("x_search");
  });

  it("classifies Gemini 3 as supporting mixed native Google and function tools", () => {
    expect(supportsGoogleNativeToolsWithFunctionTools("gemini-2.5-pro")).toBe(false);
    expect(supportsGoogleNativeToolsWithFunctionTools("gemini-3.1-pro-preview")).toBe(true);
    expect(supportsGoogleNativeToolsWithFunctionTools("gemini-3.5-flash")).toBe(true);
    expect(supportsGoogleNativeToolsWithFunctionTools("models/gemini-3.5-flash")).toBe(true);
    expect(supportsGoogleNativeToolsWithFunctionTools("gemini-4-pro")).toBe(false);
  });

  it("agent_skill_write schema rejects an advertise tool argument (advertise is authored in content)", () => {
    const parsed = TOOL_DEFINITIONS.agent_skill_write.schema.safeParse({
      name: "demo-skill",
      content: "---\nname: demo-skill\ndescription: demo\n---\n",
      advertise: false,
    });
    expect(parsed.success).toBe(false);
  });

  describe("skills_catalog_read schema", () => {
    it("rejects invalid skillId values", () => {
      const schema = TOOL_DEFINITIONS.skills_catalog_read.schema;
      const validBase = { owner: "test-owner", repo: "test-repo" };

      // Path traversal attempts
      expect(schema.safeParse({ ...validBase, skillId: "../escape" }).success).toBe(false);
      expect(schema.safeParse({ ...validBase, skillId: "../../etc/passwd" }).success).toBe(false);

      // Absolute paths
      expect(schema.safeParse({ ...validBase, skillId: "/tmp/a" }).success).toBe(false);

      // Invalid format (uppercase, underscores, etc.)
      expect(schema.safeParse({ ...validBase, skillId: "Bad_Name" }).success).toBe(false);
      expect(schema.safeParse({ ...validBase, skillId: "UPPER" }).success).toBe(false);

      // Valid skill names should pass
      expect(schema.safeParse({ ...validBase, skillId: "my-skill" }).success).toBe(true);
      expect(schema.safeParse({ ...validBase, skillId: "skill123" }).success).toBe(true);
    });
  });
});
