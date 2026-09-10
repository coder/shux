import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { AgentReportToolCall } from "./AgentReportToolCall";

describe("AgentReportToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    // Save original globals
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    // Set up test globals
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();

    // Restore original globals
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("renders reportMarkdown as markdown", () => {
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall
          args={{
            reportMarkdown: "# Hello\n\nWorld",
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    // Validate that markdown body content renders regardless of whether another test
    // has mocked MarkdownCore into plain-text fallback mode in this Bun process.
    expect(view.getByText(/Hello/)).toBeTruthy();
    expect(view.getByText(/World/)).toBeTruthy();
  });

  test("renders legacy file-backed report payload from successful tool output", () => {
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall
          args={{
            reportMarkdownPath: "report.md",
            structuredOutputPath: "structured-output.json",
            title: null,
          }}
          result={{
            success: true,
            message: "Report submitted successfully.",
            report: { reportMarkdown: "# Legacy Report\n\nFrom disk" },
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    expect(view.getByText(/Legacy Report/)).toBeTruthy();
    expect(view.getByText(/From disk/)).toBeTruthy();
  });

  test("renders default legacy file-backed report placeholder for empty input", () => {
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall args={{}} status="executing" />
      </TooltipProvider>
    );

    expect(view.getByText(/Report file: report\.md/)).toBeTruthy();
  });

  test("collapses the body while retaining the title, then reopens it", () => {
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall
          args={{ title: "Recovery audit", reportMarkdown: "Summary\n\nDetailed findings" }}
          result={{ success: true }}
          status="completed"
        />
      </TooltipProvider>
    );
    const toggle = view.getByRole("button", { name: "Recovery audit" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByText("Detailed findings")).toBeNull();
    fireEvent.click(toggle);
    expect(view.getByText(/Detailed findings/)).toBeTruthy();
  });

  test("keeps validation failures visible when collapsed instead of claiming delivery", () => {
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall
          args={{ title: "Audit", reportMarkdown: "Draft" }}
          result={{
            success: false,
            message: "Report rejected",
            errors: [{ path: "reportMarkdown", message: "Report exceeds limit" }],
          }}
          status="completed"
        />
      </TooltipProvider>
    );
    fireEvent.click(view.getByRole("button", { name: "Audit" }));
    expect(view.getByRole("alert").textContent).toContain("Report exceeds limit");
    expect(view.getByRole("status").className).toContain("text-danger");
  });

  test("prefers the submitted report over the draft arguments", () => {
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall
          args={{ reportMarkdown: "Draft report" }}
          result={{ success: true, report: { reportMarkdown: "Accepted report" } }}
          status="completed"
        />
      </TooltipProvider>
    );
    expect(view.queryByText("Draft report")).toBeNull();
    expect(view.getByText("Accepted report")).toBeTruthy();
  });

  test.each(["", "   "])("keeps the report toggle named for a blank title: %j", (title) => {
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall args={{ title, reportMarkdown: "Findings" }} status="completed" />
      </TooltipProvider>
    );
    expect(view.getByRole("button", { name: /\S/ })).toBeTruthy();
  });

  test.each(
    ["legacy output", 42, true, [], { success: false, message: "Missing errors" }].map(
      (result) => ({ result })
    )
  )("keeps malformed persisted report results renderable: %j", ({ result }) => {
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall
          args={{ reportMarkdown: "Preserved findings" }}
          result={result}
          status="completed"
        />
      </TooltipProvider>
    );
    expect(view.getByText("Preserved findings")).toBeTruthy();
    expect(view.getByRole("status").className).not.toContain("text-success");
  });

  test("accepts report results decorated by post hooks without mutating hook output", () => {
    const result = Object.freeze({
      success: true,
      report: { reportMarkdown: "Submitted findings" },
      hook_output: "Formatter completed",
      hook_duration_ms: 20,
      hook_path: ".xum/tool_post",
      ui_only: {},
    });
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall
          args={{ reportMarkdownPath: "report.md" }}
          result={result}
          status="completed"
        />
      </TooltipProvider>
    );
    expect(view.getByText("Submitted findings")).toBeTruthy();
    expect(view.getByRole("status").className).toContain("text-success");
  });

  test("shows bare pre-hook blocking errors", () => {
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall
          args={{ reportMarkdown: "Draft" }}
          result={{ error: "Blocked by project hook" }}
          status="completed"
        />
      </TooltipProvider>
    );
    expect(view.getByRole("alert").textContent).toBe("Blocked by project hook");
    expect(view.getByRole("status").className).toContain("text-danger");
  });

  test.each([null, undefined, { type: "json", value: null }].map((result) => ({ result })))(
    "does not claim delivery for a missing completed result: %j",
    ({ result }) => {
      const view = render(
        <TooltipProvider>
          <AgentReportToolCall
            args={{ reportMarkdown: "Findings" }}
            result={result}
            status="completed"
          />
        </TooltipProvider>
      );
      expect(view.getByRole("status").className).not.toContain("text-success");
      expect(view.getByRole("status").textContent).toBe("Result unavailable");
    }
  );

  test.each([
    { status: "pending", label: "Pending" },
    { status: "executing", label: "Sending…" },
    { status: "failed", label: "Not sent" },
    { status: "interrupted", label: "Interrupted" },
  ] as const)("preserves lifecycle status without a result: $status", ({ status, label }) => {
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall args={{ reportMarkdown: "Findings" }} result={null} status={status} />
      </TooltipProvider>
    );
    expect(view.getByRole("status").textContent).toBe(label);
  });

  test("accepts SDK-wrapped results with inner and outer hook metadata", () => {
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall
          args={{ reportMarkdown: "Findings" }}
          status="completed"
          result={Object.freeze({
            type: "json",
            value: Object.freeze({ ...{ success: true }, hook_output: "Inner hook" }),
            hook_output: "Outer hook",
            hook_path: ".xum/tool_post",
          })}
        />
      </TooltipProvider>
    );
    expect(view.getByRole("status").className).toContain("text-success");
  });

  test("shows SDK-wrapped blocking errors", () => {
    const view = render(
      <TooltipProvider>
        <AgentReportToolCall
          args={{ reportMarkdown: "Findings" }}
          status="completed"
          result={{
            type: "json",
            value: { error: "Wrapped blocking error" },
          }}
        />
      </TooltipProvider>
    );
    expect(view.getByRole("alert").textContent).toBe("Wrapped blocking error");
  });
});
