import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { MessageListProvider } from "@/browser/features/Messages/MessageListContext";
import { ToolNameProvider } from "@/browser/features/Messages/ToolNameContext";
import type {
  TaskWorkspaceLifecycleStatus,
  TaskWorkspaceLifecycleTargetResult,
} from "@/common/types/tools";
import { summarizeOutcomeGroups, WorkspaceLifecycleToolCall } from "./WorkspaceLifecycleToolCall";

const TEST_WORKSPACE_ID = "workspace-lifecycle-test";

// ToolIcon renders a Radix Tooltip which requires a TooltipProvider and contexts.
function renderWithProviders(ui: ReactElement) {
  return render(
    <ThemeProvider forcedTheme="dark">
      <MessageListProvider value={{ workspaceId: TEST_WORKSPACE_ID, latestMessageId: null }}>
        <ToolNameProvider toolName="task_workspace_lifecycle">
          <TooltipProvider>{ui}</TooltipProvider>
        </ToolNameProvider>
      </MessageListProvider>
    </ThemeProvider>
  );
}

function row(
  status: TaskWorkspaceLifecycleStatus,
  extra: Partial<TaskWorkspaceLifecycleTargetResult> = {}
): TaskWorkspaceLifecycleTargetResult {
  // `status` is a runtime variable, so the literal can't be inferred as a single
  // discriminated-union member; assert through a variable (not an object literal) to
  // satisfy consistent-type-assertions.
  const built = { status, action: "archive", workspaceId: "w", ...extra };
  return built as unknown as TaskWorkspaceLifecycleTargetResult;
}

describe("summarizeOutcomeGroups", () => {
  // Locks the severity classification: which lifecycle states read as "settled" (in the
  // desired state), "blocked" (need a follow-up flag/step), or "failed" (scope/ownership
  // error). This drives the collapsed header's tone and chip counts, so it is user-visible
  // behavior — not prose.
  const EXPECTED: Record<
    TaskWorkspaceLifecycleStatus,
    keyof ReturnType<typeof summarizeOutcomeGroups>
  > = {
    archived: "settled",
    already_archived: "settled",
    unarchived: "settled",
    already_unarchived: "settled",
    deleted_worktree: "settled",
    already_transcript_only: "settled",
    removed: "settled",
    already_removed: "settled",
    not_found: "settled",
    requires_archive: "blocked",
    requires_confirmation: "blocked",
    active: "blocked",
    invalid_scope: "failed",
    error: "failed",
  };

  for (const [status, group] of Object.entries(EXPECTED)) {
    test(`${status} → ${group}`, () => {
      const counts = summarizeOutcomeGroups([row(status as TaskWorkspaceLifecycleStatus)]);
      expect(counts[group]).toBe(1);
      const others = (["settled", "blocked", "failed"] as const).filter((g) => g !== group);
      for (const other of others) expect(counts[other]).toBe(0);
    });
  }

  test("tallies a mixed batch across all three groups", () => {
    expect(summarizeOutcomeGroups([row("archived"), row("active"), row("error")])).toEqual({
      settled: 1,
      blocked: 1,
      failed: 1,
    });
  });
});

describe("WorkspaceLifecycleToolCall", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("expanded card surfaces per-row blocked details (paths + active turns)", () => {
    const view = renderWithProviders(
      <WorkspaceLifecycleToolCall
        args={{
          action: "archive",
          targets: [{ workspaceId: "ws-confirm" }, { workspaceId: "ws-active" }],
        }}
        status="completed"
        defaultExpanded
        result={{
          results: [
            {
              status: "requires_confirmation",
              action: "archive",
              workspaceId: "ws-confirm",
              paths: ["src/scratch.local.ts"],
            },
            {
              status: "active",
              action: "archive",
              workspaceId: "ws-active",
              activeTaskIds: ["wst_running01"],
            },
          ],
        }}
      />
    );
    // Conditional detail branches: the untracked path and the active turn id (both data,
    // not copy) render only because the rows have those fields.
    expect(view.queryByText("src/scratch.local.ts")).not.toBeNull();
    expect(view.queryByText("wst_running01")).not.toBeNull();
  });

  test("renders captured workspace display name while keeping identifiers visible", () => {
    const view = renderWithProviders(
      <WorkspaceLifecycleToolCall
        args={{ action: "archive", targets: [{ taskId: "wst_display" }] }}
        status="completed"
        defaultExpanded
        result={{
          results: [
            {
              status: "archived",
              action: "archive",
              taskId: "wst_display",
              workspaceId: "ws-display",
              displayName: "Archive cleanup",
            },
          ],
        }}
      />
    );

    expect(view.queryByText("Archive cleanup")).not.toBeNull();
    expect(view.queryByText(/ws-display/)).not.toBeNull();
    expect(view.queryByText(/wst_display/)).not.toBeNull();
  });

  test("self-heals a malformed result by falling back to the requested targets", () => {
    const view = renderWithProviders(
      <WorkspaceLifecycleToolCall
        args={{ action: "remove", targets: [{ workspaceId: "arg-fallback-id" }] }}
        status="completed"
        defaultExpanded
        // Not a valid { results: [...] } payload — must not throw, must surface the request.
        result={{ unexpected: "shape" }}
      />
    );
    expect(view.queryByText("arg-fallback-id")).not.toBeNull();
  });

  test("unwraps a JSON-containered result before parsing", () => {
    const view = renderWithProviders(
      <WorkspaceLifecycleToolCall
        args={{ action: "archive", targets: [{ workspaceId: "arg-target" }] }}
        status="completed"
        defaultExpanded
        // SDK JSON-container shape — the real { results: [...] } is nested under `value`.
        result={{
          type: "json",
          value: {
            results: [{ status: "archived", action: "archive", workspaceId: "row-ws-unwrapped" }],
          },
        }}
      />
    );
    // The row from the unwrapped payload renders; the requested-targets fallback (which would
    // show the arg id) does not — i.e. the container was unwrapped, not treated as malformed.
    expect(view.queryByText("row-ws-unwrapped")).not.toBeNull();
    expect(view.queryByText("arg-target")).toBeNull();
  });

  test("renders the shared error box for a thrown { success: false } result", () => {
    const view = renderWithProviders(
      <WorkspaceLifecycleToolCall
        args={{ action: "remove", targets: [{ workspaceId: "ws-1" }] }}
        status="failed"
        defaultExpanded
        result={{ success: false, error: "needs an orchestrator workspace context" }}
      />
    );
    expect(view.queryByText("needs an orchestrator workspace context")).not.toBeNull();
    // The requested-targets fallback is suppressed when there is a top-level error.
    expect(view.queryByText("ws-1")).toBeNull();
  });

  test("surfaces a nested { error } failure (no success flag) instead of the fallback", () => {
    const view = renderWithProviders(
      <WorkspaceLifecycleToolCall
        args={{ action: "archive", targets: [{ workspaceId: "ws-nested" }] }}
        status="failed"
        defaultExpanded
        // code_execution/PTC reconstructs nested failures as { error } with no success flag.
        result={{ error: "child workspace is not owned by this orchestrator" }}
      />
    );
    expect(view.queryByText("child workspace is not owned by this orchestrator")).not.toBeNull();
    expect(view.queryByText("ws-nested")).toBeNull();
  });
});
