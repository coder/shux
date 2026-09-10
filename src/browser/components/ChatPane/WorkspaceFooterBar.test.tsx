import "../../../../tests/ui/dom";

import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import * as ProjectContextModule from "@/browser/contexts/ProjectContext";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as GitStatusStoreModule from "@/browser/stores/GitStatusStore";
import * as PRStatusStoreModule from "@/browser/stores/PRStatusStore";
import * as RuntimeStatusStoreModule from "@/browser/stores/RuntimeStatusStore";
import * as RuntimeBadgeModule from "../RuntimeBadge/RuntimeBadge";
import * as BranchSelectorModule from "../BranchSelector/BranchSelector";
import * as GitStatusIndicatorModule from "../GitStatusIndicator/GitStatusIndicator";
import * as MultiProjectGitStatusIndicatorModule from "../GitStatusIndicator/MultiProjectGitStatusIndicator";
import * as WorkspaceLinksModule from "../WorkspaceLinks/WorkspaceLinks";
import { TooltipProvider } from "../Tooltip/Tooltip";
import type { WorkspaceFooterBar as WorkspaceFooterBarComponent } from "./WorkspaceFooterBar";
import type { DisplayedMessage } from "@/common/types/message";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { CUSTOM_EVENTS } from "@/common/constants/events";

let WorkspaceFooterBar!: typeof WorkspaceFooterBarComponent;

let workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();
let workspaceState = {
  messages: [] as DisplayedMessage[],
  muxMessages: [],
  hasOlderHistory: false,
};
let loadOlderHistory = (): Promise<"loaded" | "exhausted" | "busy" | "unavailable" | "failed"> =>
  Promise.resolve("exhausted");
let cleanupDom: (() => void) | null = null;
const workspaceId = "workspace-1";

function installFooterBarTestDoubles() {
  spyOn(WorkspaceContextModule, "useWorkspaceContext").mockImplementation(
    () =>
      ({ workspaceMetadata }) as unknown as ReturnType<
        typeof WorkspaceContextModule.useWorkspaceContext
      >
  );
  spyOn(ProjectContextModule, "useProjectContext").mockImplementation(
    () =>
      ({ userProjects: new Map() }) as unknown as ReturnType<
        typeof ProjectContextModule.useProjectContext
      >
  );
  spyOn(WorkspaceStoreModule, "useWorkspaceSidebarState").mockImplementation(
    () =>
      ({
        canInterrupt: false,
        isStarting: false,
        awaitingUserQuestion: false,
      }) as unknown as ReturnType<typeof WorkspaceStoreModule.useWorkspaceSidebarState>
  );
  spyOn(WorkspaceStoreModule, "useWorkspaceUsage").mockImplementation(
    () =>
      ({ totalTokens: 0 }) as unknown as ReturnType<typeof WorkspaceStoreModule.useWorkspaceUsage>
  );
  spyOn(WorkspaceStoreModule, "useWorkspaceStreamingStats").mockImplementation(() => null);
  spyOn(WorkspaceStoreModule, "useWorkspaceLastUserPromptInfo").mockImplementation(() => null);
  spyOn(WorkspaceStoreModule, "useWorkspaceStoreRaw").mockImplementation(
    () =>
      ({
        getWorkspaceState: () => workspaceState,
        loadOlderHistory: () => loadOlderHistory(),
      }) as unknown as ReturnType<typeof WorkspaceStoreModule.useWorkspaceStoreRaw>
  );
  spyOn(GitStatusStoreModule, "useGitStatus").mockImplementation(() => null);
  spyOn(PRStatusStoreModule, "useWorkspacePR").mockImplementation(() => null);
  spyOn(RuntimeStatusStoreModule, "useRuntimeStatus").mockImplementation(() => "unsupported");

  spyOn(RuntimeBadgeModule, "RuntimeBadge").mockImplementation(
    (() => null) as unknown as typeof RuntimeBadgeModule.RuntimeBadge
  );
  spyOn(BranchSelectorModule, "BranchSelector").mockImplementation(
    (() => null) as unknown as typeof BranchSelectorModule.BranchSelector
  );
  spyOn(GitStatusIndicatorModule, "GitStatusIndicator").mockImplementation(
    (() => null) as unknown as typeof GitStatusIndicatorModule.GitStatusIndicator
  );
  spyOn(MultiProjectGitStatusIndicatorModule, "MultiProjectGitStatusIndicator").mockImplementation(
    (() =>
      null) as unknown as typeof MultiProjectGitStatusIndicatorModule.MultiProjectGitStatusIndicator
  );
  spyOn(WorkspaceLinksModule, "WorkspaceLinks").mockImplementation(
    (() => null) as unknown as typeof WorkspaceLinksModule.WorkspaceLinks
  );
}

const repoMetadata: FrontendWorkspaceMetadata = {
  id: workspaceId,
  name: "feature-branch",
  projectName: "demo",
  projectPath: "/projects/demo",
  namedWorkspacePath: "/projects/demo/workspaces/feature-branch",
  runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
  createdAt: "2026-01-01T00:00:00.000Z",
};

function mockDetectedPR() {
  spyOn(PRStatusStoreModule, "useWorkspacePR").mockImplementation(
    () =>
      ({
        type: "github-pr",
        url: "https://github.com/acme/widgets/pull/7",
        owner: "acme",
        repo: "widgets",
        number: 7,
        detectedAt: 0,
        occurrenceCount: 1,
      }) as unknown as ReturnType<typeof PRStatusStoreModule.useWorkspacePR>
  );
}

function renderFooter(overrides?: Partial<ComponentProps<typeof WorkspaceFooterBarComponent>>) {
  return render(
    <TooltipProvider delayDuration={0}>
      <WorkspaceFooterBar
        workspaceId={workspaceId}
        projectName="demo"
        projectPath="/projects/demo"
        workspaceName="feature-branch"
        namedWorkspacePath="/projects/demo/workspaces/feature-branch"
        runtimeConfig={{ type: "worktree", srcBaseDir: "/tmp/src" }}
        {...overrides}
      />
    </TooltipProvider>
  );
}

function makeUserMessage(historyId: string): DisplayedMessage {
  return {
    type: "user",
    id: historyId,
    historyId,
    content: "ship the footer",
    historySequence: 1,
  };
}

describe("WorkspaceFooterBar repository controls", () => {
  beforeEach(() => {
    workspaceMetadata = new Map();
    workspaceState = { messages: [], muxMessages: [], hasOlderHistory: false };
    loadOlderHistory = () => Promise.resolve("exhausted" as const);
    cleanupDom = installDom();
    installFooterBarTestDoubles();
    /* eslint-disable @typescript-eslint/no-require-imports */
    ({ WorkspaceFooterBar } = require("./WorkspaceFooterBar?workspace-footer-bar-test=1") as {
      WorkspaceFooterBar: typeof WorkspaceFooterBarComponent;
    });
    /* eslint-enable @typescript-eslint/no-require-imports */
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("hides repository controls for scratch workspaces", () => {
    const scratchPath = "/home/user/.mux/scratch/workspace-1";
    const scratchMetadata: FrontendWorkspaceMetadata = {
      ...repoMetadata,
      kind: "scratch",
      name: "scratch-workspace-1",
      projectName: "Scratch",
      projectPath: scratchPath,
      namedWorkspacePath: scratchPath,
      runtimeConfig: { type: "local" },
    };
    workspaceMetadata.set(workspaceId, scratchMetadata);

    renderFooter({
      projectName: "Scratch",
      projectPath: scratchPath,
      workspaceName: "scratch-workspace-1",
      namedWorkspacePath: scratchPath,
      runtimeConfig: { type: "local" },
    });

    expect(BranchSelectorModule.BranchSelector).not.toHaveBeenCalled();
    expect(GitStatusIndicatorModule.GitStatusIndicator).not.toHaveBeenCalled();
    expect(
      MultiProjectGitStatusIndicatorModule.MultiProjectGitStatusIndicator
    ).not.toHaveBeenCalled();
  });

  it("shows branch + single-project git status for repo-backed workspaces", () => {
    workspaceMetadata.set(workspaceId, repoMetadata);

    renderFooter();

    expect(BranchSelectorModule.BranchSelector).toHaveBeenCalled();
    expect(GitStatusIndicatorModule.GitStatusIndicator).toHaveBeenCalled();
    expect(
      MultiProjectGitStatusIndicatorModule.MultiProjectGitStatusIndicator
    ).not.toHaveBeenCalled();
  });

  it("uses the multi-project git status indicator for multi-project workspaces", () => {
    const multiProjectMetadata: FrontendWorkspaceMetadata = {
      ...repoMetadata,
      projects: [
        { projectPath: "/projects/demo", projectName: "demo" },
        { projectPath: "/projects/other", projectName: "other" },
      ],
    };
    workspaceMetadata.set(workspaceId, multiProjectMetadata);

    renderFooter();

    expect(MultiProjectGitStatusIndicatorModule.MultiProjectGitStatusIndicator).toHaveBeenCalled();
    expect(GitStatusIndicatorModule.GitStatusIndicator).not.toHaveBeenCalled();
  });

  it("omits the drift mode toggle for multi-project workspaces", () => {
    const multiProjectMetadata: FrontendWorkspaceMetadata = {
      ...repoMetadata,
      projects: [
        { projectPath: "/projects/demo", projectName: "demo" },
        { projectPath: "/projects/other", projectName: "other" },
      ],
    };
    workspaceMetadata.set(workspaceId, multiProjectMetadata);

    const { container } = renderFooter();

    expect(container.textContent).not.toContain("Lines");
  });

  it("shows the drift mode toggle for single-repository workspaces", () => {
    workspaceMetadata.set(workspaceId, repoMetadata);

    const { container } = renderFooter();

    expect(container.textContent).toContain("Lines");
  });

  it("shows the GitHub slug instead of the project label once a PR is detected", () => {
    workspaceMetadata.set(workspaceId, repoMetadata);
    mockDetectedPR();

    const { container } = renderFooter();

    expect(container.textContent).toContain("acme/widgets");
    expect(container.textContent).not.toContain("demo");
  });

  it("links the GitHub slug to the repository page", () => {
    workspaceMetadata.set(workspaceId, repoMetadata);
    mockDetectedPR();

    const { getByTestId } = renderFooter();

    expect(getByTestId("workspace-footer-repository").getAttribute("href")).toBe(
      "https://github.com/acme/widgets"
    );
  });

  it("falls back to the project label when no PR is detected", () => {
    workspaceMetadata.set(workspaceId, repoMetadata);

    const { container } = renderFooter();

    expect(container.textContent).toContain("demo");
  });
});

describe("WorkspaceFooterBar last prompt", () => {
  beforeEach(() => {
    workspaceMetadata = new Map();
    workspaceState = { messages: [], muxMessages: [], hasOlderHistory: false };
    loadOlderHistory = () => Promise.resolve("exhausted" as const);
    cleanupDom = installDom();
    installFooterBarTestDoubles();
    workspaceMetadata.set(workspaceId, repoMetadata);
    /* eslint-disable @typescript-eslint/no-require-imports */
    ({ WorkspaceFooterBar } = require("./WorkspaceFooterBar?workspace-footer-bar-test=2") as {
      WorkspaceFooterBar: typeof WorkspaceFooterBarComponent;
    });
    /* eslint-enable @typescript-eslint/no-require-imports */
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("omits the item when the transcript has no user prompt", () => {
    const { queryByTestId } = renderFooter();

    expect(queryByTestId("workspace-footer-last-prompt")).toBeNull();
  });

  it("renders the item once a user prompt exists", () => {
    spyOn(WorkspaceStoreModule, "useWorkspaceLastUserPromptInfo").mockImplementation(() => ({
      text: "ship the footer",
      messageId: "prompt-1",
    }));

    const { queryByTestId } = renderFooter();

    expect(queryByTestId("workspace-footer-last-prompt")).not.toBeNull();
  });

  it("toggles the prompt popover from the keyboard shortcut", () => {
    spyOn(WorkspaceStoreModule, "useWorkspaceLastUserPromptInfo").mockImplementation(() => ({
      text: "ship the footer",
      messageId: "prompt-1",
    }));

    const { getByTestId } = renderFooter();
    const trigger = getByTestId("workspace-footer-last-prompt");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(window, { key: "L", ctrlKey: true, shiftKey: true });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(window, { key: "L", ctrlKey: true, shiftKey: true });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("reveals the last prompt from the popup", async () => {
    workspaceState = {
      messages: [makeUserMessage("prompt-1")],
      muxMessages: [],
      hasOlderHistory: false,
    };
    spyOn(WorkspaceStoreModule, "useWorkspaceLastUserPromptInfo").mockImplementation(() => ({
      text: "ship the footer",
      messageId: "prompt-1",
    }));
    const revealed: Event[] = [];
    const listener = (event: Event) => revealed.push(event);
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);

    try {
      const view = renderFooter();
      fireEvent.click(view.getByTestId("workspace-footer-last-prompt"));
      fireEvent.click(view.getByTestId("workspace-footer-last-prompt-reveal"));

      await waitFor(() => expect(revealed).toHaveLength(1));
      expect((revealed[0] as CustomEvent).detail).toEqual({
        workspaceId,
        messageId: "prompt-1",
      });
      expect(view.queryByTestId("workspace-footer-last-prompt-reveal")).toBeNull();
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);
    }
  });

  it("reveals the last prompt from its shortcut while the popup is open", async () => {
    workspaceState = {
      messages: [makeUserMessage("prompt-shortcut")],
      muxMessages: [],
      hasOlderHistory: false,
    };
    spyOn(WorkspaceStoreModule, "useWorkspaceLastUserPromptInfo").mockImplementation(() => ({
      text: "ship the footer",
      messageId: "prompt-shortcut",
    }));
    const revealed: Event[] = [];
    const listener = (event: Event) => revealed.push(event);
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);

    try {
      const view = renderFooter();
      fireEvent.click(view.getByTestId("workspace-footer-last-prompt"));
      fireEvent.keyDown(window, { key: "Enter", ctrlKey: true, altKey: true });

      await waitFor(() => expect(revealed).toHaveLength(1));
      expect((revealed[0] as CustomEvent).detail).toEqual({
        workspaceId,
        messageId: "prompt-shortcut",
      });
      expect(view.queryByTestId("workspace-footer-last-prompt-reveal")).toBeNull();
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);
    }
  });

  it("does not reveal an obsolete prompt after a newer prompt arrives", async () => {
    let resolveLoad: ((result: "loaded") => void) | undefined;
    loadOlderHistory = () =>
      new Promise<"loaded">((resolve) => {
        resolveLoad = resolve;
      });
    workspaceState = {
      messages: [],
      muxMessages: [],
      hasOlderHistory: true,
    };
    let currentPrompt: { text: string; messageId: string } | null = {
      text: "old prompt",
      messageId: "prompt-old",
    };
    spyOn(WorkspaceStoreModule, "useWorkspaceLastUserPromptInfo").mockImplementation(
      () => currentPrompt
    );
    const revealed: Event[] = [];
    const listener = (event: Event) => revealed.push(event);
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);

    try {
      const view = renderFooter();
      fireEvent.click(view.getByTestId("workspace-footer-last-prompt"));
      fireEvent.click(view.getByTestId("workspace-footer-last-prompt-reveal"));
      await Promise.resolve();

      currentPrompt = { text: "new prompt", messageId: "prompt-new" };
      view.rerender(
        <TooltipProvider delayDuration={0}>
          <WorkspaceFooterBar
            workspaceId={workspaceId}
            projectName="demo"
            projectPath="/projects/demo"
            workspaceName="feature-branch"
            namedWorkspacePath="/projects/demo/workspaces/feature-branch"
            runtimeConfig={{ type: "worktree", srcBaseDir: "/tmp/src" }}
          />
        </TooltipProvider>
      );
      workspaceState.messages = [makeUserMessage("prompt-old")];
      workspaceState.hasOlderHistory = false;
      resolveLoad?.("loaded");

      const result = await Promise.resolve().then(
        () => new Promise<void>((resolve) => setTimeout(resolve, 0))
      );
      void result;
      expect(revealed).toHaveLength(0);
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);
    }
  });

  it("does not reopen the popover when a prompt returns after being absent", () => {
    let currentPrompt: { text: string; messageId: string } | null = {
      text: "ship the footer",
      messageId: "prompt-1",
    };
    spyOn(WorkspaceStoreModule, "useWorkspaceLastUserPromptInfo").mockImplementation(
      () => currentPrompt
    );

    const view = renderFooter();
    fireEvent.keyDown(window, { key: "L", ctrlKey: true, shiftKey: true });
    expect(view.getByTestId("workspace-footer-last-prompt").getAttribute("aria-expanded")).toBe(
      "true"
    );

    currentPrompt = null;
    view.rerender(
      <TooltipProvider delayDuration={0}>
        <WorkspaceFooterBar
          workspaceId={workspaceId}
          projectName="demo"
          projectPath="/projects/demo"
          workspaceName="feature-branch"
          namedWorkspacePath="/projects/demo/workspaces/feature-branch"
          runtimeConfig={{ type: "worktree", srcBaseDir: "/tmp/src" }}
        />
      </TooltipProvider>
    );
    expect(view.queryByTestId("workspace-footer-last-prompt")).toBeNull();

    currentPrompt = { text: "a brand new prompt", messageId: "prompt-2" };
    view.rerender(
      <TooltipProvider delayDuration={0}>
        <WorkspaceFooterBar
          workspaceId={workspaceId}
          projectName="demo"
          projectPath="/projects/demo"
          workspaceName="feature-branch"
          namedWorkspacePath="/projects/demo/workspaces/feature-branch"
          runtimeConfig={{ type: "worktree", srcBaseDir: "/tmp/src" }}
        />
      </TooltipProvider>
    );
    expect(view.getByTestId("workspace-footer-last-prompt").getAttribute("aria-expanded")).toBe(
      "false"
    );
  });
});
