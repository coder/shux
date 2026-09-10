import { describe, expect, test } from "bun:test";

import { AgentReportToolCall } from "../AgentReportToolCall";
import { GenericToolCall } from "../GenericToolCall";
import { IntuitionToolCall } from "../IntuitionToolCall";
import { GoogleSearchToolCall } from "../GoogleSearchToolCall";
import { ToolSearchToolCall } from "../ToolSearchToolCall";
import { WorkspaceLifecycleToolCall } from "../WorkspaceLifecycleToolCall";
import { WorkflowRunToolCall } from "../WorkflowRunToolCall";
import { getToolComponent } from "./getToolComponent";

describe("getToolComponent", () => {
  test("falls back to generic rendering for removed or unknown tools", () => {
    expect(getToolComponent("workflow_list", {})).toBe(GenericToolCall);
    expect(getToolComponent("unknown_tool", {})).toBe(GenericToolCall);
  });

  test("renders legacy file-backed agent_report transcripts", () => {
    expect(
      getToolComponent("agent_report", {
        reportMarkdownPath: "report.md",
        structuredOutputPath: "structured-output.json",
        title: null,
      })
    ).toBe(AgentReportToolCall);
    expect(getToolComponent("agent_report", {})).toBe(AgentReportToolCall);
  });

  test("routes kernel-bounded workflow_run args to the workflow card", () => {
    // Kernel-nested calls with oversized launch args arrive as a marker; the
    // card renders from the attached durable run instead of raw JSON.
    const marker = { __kernelBounded: true, bytes: 18_457, preview: '{"script_path":"skill…' };
    expect(getToolComponent("workflow_run", marker)).toBe(WorkflowRunToolCall);
    expect(
      getToolComponent("workflow_run", { ...marker, script_path: "skill://demo/workflow.js" })
    ).toBe(WorkflowRunToolCall);
    // Other tools keep the generic fallback for bounded args.
    expect(getToolComponent("bash", marker)).toBe(GenericToolCall);
  });

  test("renders historical workspace lifecycle actions", () => {
    expect(
      getToolComponent("task_workspace_lifecycle", {
        action: "remove",
        targets: [{ workspaceId: "workspace-id" }],
        force: true,
      })
    ).toBe(WorkspaceLifecycleToolCall);
  });

  test("falls back when catalog schema validation fails", () => {
    expect(getToolComponent("agent_skill_list", { includeUnadvertised: "yes" })).toBe(
      GenericToolCall
    );
    expect(getToolComponent("agent_report", { reportMarkdown: "" })).toBe(GenericToolCall);
  });

  test("keeps provider-executed Google search calls visible while arguments stream", () => {
    expect(getToolComponent("server:GOOGLE_SEARCH_WEB", { queries: ["gemini 3 pricing"] })).toBe(
      GoogleSearchToolCall
    );
    expect(getToolComponent("server:GOOGLE_SEARCH_WEB", {})).toBe(GoogleSearchToolCall);
    expect(getToolComponent("server:GOOGLE_SEARCH_WEB", { queries: "not-an-array" })).toBe(
      GenericToolCall
    );
  });

  test("uses the intuition card only for valid cue arguments", () => {
    expect(getToolComponent("intuition", { cue: "Recall deployment constraints" })).toBe(
      IntuitionToolCall
    );
    expect(getToolComponent("intuition", { cue: "" })).toBe(GenericToolCall);
    expect(getToolComponent("intuition", { cue: { nested: true } })).toBe(GenericToolCall);
  });

  test("renders legacy tool_search transcript calls", () => {
    expect(getToolComponent("tool_search", { query: "send slack message" })).toBe(
      ToolSearchToolCall
    );
  });

  test("Object.prototype member names fall back instead of throwing", () => {
    expect(getToolComponent("constructor", {})).toBe(GenericToolCall);
    expect(getToolComponent("__proto__", {})).toBe(GenericToolCall);
    expect(getToolComponent("toString", {})).toBe(GenericToolCall);
  });
});
