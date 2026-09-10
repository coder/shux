import * as RealMarkdownCore from "../Messages/MarkdownCore";
import * as RealMarkdownRenderer from "../Messages/MarkdownRenderer";
import * as RealAPI from "@/browser/contexts/API";
import type { ReactNode } from "react";
import { PlanFileDialog } from "./PlanFileDialog";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render, waitFor } from "@testing-library/react";
import * as RealDialogModule from "@/browser/components/Dialog/Dialog";

type GetPlanContentResult =
  | { success: true; data: { content: string; path: string } }
  | { success: false; error: string };

interface MockApiClient {
  workspace: {
    getPlanContent: () => Promise<GetPlanContentResult>;
  };
}

let mockApi: MockApiClient | null = null;

// Scope module mocks to each test so renderer assertions use the real pipeline.
const realModules: Array<[string, Record<string, unknown>]> = [
  ["@/browser/components/Dialog/Dialog", { ...RealDialogModule }],
  ["@/browser/features/Messages/MarkdownCore", { ...RealMarkdownCore }],
  ["@/browser/features/Messages/MarkdownRenderer", { ...RealMarkdownRenderer }],
  ["@/browser/contexts/API", { ...RealAPI }],
];

async function installModuleMocks() {
  await mock.module("@/browser/components/Dialog/Dialog", () => ({
    Dialog: (props: { open: boolean; children: ReactNode }) =>
      props.open ? <div>{props.children}</div> : null,
    DialogContent: (props: { children: ReactNode; className?: string }) => (
      <div className={props.className}>{props.children}</div>
    ),
    DialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
    DialogTitle: (props: { children: ReactNode; className?: string }) => (
      <h2 className={props.className}>{props.children}</h2>
    ),
  }));

  await mock.module("@/browser/features/Messages/MarkdownCore", () => ({
    MarkdownCore: (props: { content: string }) => (
      <div data-testid="plan-markdown-core">{props.content}</div>
    ),
  }));

  await mock.module("@/browser/features/Messages/MarkdownRenderer", () => ({
    PlanMarkdownContainer: (props: { children: ReactNode }) => (
      <div data-testid="plan-markdown-container">{props.children}</div>
    ),
  }));

  await mock.module("@/browser/contexts/API", () => ({
    useAPI: () => ({
      api: mockApi,
      status: mockApi ? "connected" : "error",
      error: mockApi ? null : "API unavailable",
      authenticate: () => undefined,
      retry: () => undefined,
    }),
  }));
}

async function restoreModuleMocks() {
  for (const [path, exports] of realModules) await mock.module(path, () => exports);
}

describe("PlanFileDialog", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(async () => {
    await installModuleMocks();
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    mockApi = null;
  });

  afterEach(async () => {
    cleanup();
    await restoreModuleMocks();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("fetches plan content only after the dialog opens", async () => {
    const getPlanContent = mock(() =>
      Promise.resolve({
        success: true,
        data: {
          content: "# Plan title\n\n- item",
          path: "/tmp/plan.md",
        },
      } satisfies GetPlanContentResult)
    );

    mockApi = {
      workspace: {
        getPlanContent,
      },
    };

    const onOpenChange = () => undefined;
    const view = render(
      <PlanFileDialog open={false} onOpenChange={onOpenChange} workspaceId="workspace-1" />
    );

    expect(getPlanContent).toHaveBeenCalledTimes(0);

    view.rerender(<PlanFileDialog open onOpenChange={onOpenChange} workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(getPlanContent).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(view.getByTestId("plan-markdown-core").textContent).toContain("# Plan title");
    });

    expect(view.getByText("/tmp/plan.md")).toBeTruthy();
  });

  test("shows API error responses in the dialog", async () => {
    const getPlanContent = mock(() =>
      Promise.resolve({
        success: false,
        error: "Plan file not found",
      } satisfies GetPlanContentResult)
    );

    mockApi = {
      workspace: {
        getPlanContent,
      },
    };

    const view = render(
      <PlanFileDialog open onOpenChange={() => undefined} workspaceId="workspace-2" />
    );

    await waitFor(() => {
      expect(getPlanContent).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(view.getByTestId("plan-file-dialog-error").textContent).toContain(
        "Plan file not found"
      );
    });
  });

  test("renders API-unavailable state when not connected", async () => {
    mockApi = null;

    const view = render(
      <PlanFileDialog open onOpenChange={() => undefined} workspaceId="workspace-3" />
    );

    await waitFor(() => {
      expect(view.getByTestId("plan-file-dialog-error").textContent).toContain("API unavailable");
    });
  });
});
