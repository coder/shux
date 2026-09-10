import "../../../../tests/ui/dom";

import type { ComponentProps, PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as APIModule from "@/browser/contexts/API";
import * as AgentContextModule from "@/browser/contexts/AgentContext";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import * as ProjectContextModule from "@/browser/contexts/ProjectContext";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as RuntimeStatusStoreModule from "@/browser/stores/RuntimeStatusStore";
import * as OpenTerminalModule from "@/browser/hooks/useOpenTerminal";
import * as OpenInEditorModule from "@/browser/hooks/useOpenInEditor";
import * as PersistedStateModule from "@/browser/hooks/usePersistedState";
import * as PopoverErrorHookModule from "@/browser/hooks/usePopoverError";
import * as DesktopTitlebarModule from "@/browser/hooks/useDesktopTitlebar";
import * as TutorialContextModule from "@/browser/contexts/TutorialContext";
import * as ChatCommandsModule from "@/browser/utils/chatCommands";
import type { WorkspaceMenuBar as WorkspaceMenuBarComponent } from "./WorkspaceMenuBar";
import * as WorkspaceMCPModalModule from "../WorkspaceMCPModal/WorkspaceMCPModal";
import * as TooltipModule from "../Tooltip/Tooltip";
import * as PopoverModule from "../Popover/Popover";
import * as CheckboxModule from "../Checkbox/Checkbox";
import * as DebugLlmRequestModalModule from "../DebugLlmRequestModal/DebugLlmRequestModal";
import * as ConfirmationModalModule from "../ConfirmationModal/ConfirmationModal";
import * as PopoverErrorModule from "../PopoverError/PopoverError";
import * as WorkspaceActionsMenuContentModule from "../WorkspaceActionsMenuContent/WorkspaceActionsMenuContent";
import * as WorkspaceTerminalIconModule from "../icons/WorkspaceTerminalIcon/WorkspaceTerminalIcon";
import * as SkillIndicatorModule from "../SkillIndicator/SkillIndicator";
import * as TimelineDialogModule from "@/browser/features/RightSidebar/Timeline/TimelineDialog";

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type * as ExperimentsModuleType from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import {
  NARROW_VIEWPORT_MAX_WIDTH_PX,
  WORKSPACE_MENU_BAR_LEFT_SIDEBAR_COLLAPSED_PADDING_PX,
} from "@/constants/layout";

let WorkspaceMenuBar!: typeof WorkspaceMenuBarComponent;

let workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();
let archivingWorkspaceIds = new Set<string>();
let cleanupDom: (() => void) | null = null;
const workspaceId = "workspace-1";

function TestWrapper(props: PropsWithChildren) {
  return <>{props.children}</>;
}

// The WorkspaceActionsMenuContent test double records every render's props, so
// gating assertions read the latest call instead of clicking through the menu.
function getLastMenuContentProps() {
  const spy = WorkspaceActionsMenuContentModule.WorkspaceActionsMenuContent as unknown as {
    mock: {
      calls: Array<
        [
          {
            onForkChat?: ((anchorEl: HTMLElement) => void) | null;
            onEnterImmersiveReview?: (() => void) | null;
            onOpenTouchFullscreenReview?: (() => void) | null;
            onOpenTimeline?: (() => void) | null;
          },
        ]
      >;
    };
  };
  return spy.mock.calls.at(-1)?.[0];
}

function resolveArchivePreflight(
  result: { kind: "ready" } | { kind: "confirm-lossy-untracked-files"; paths: string[] } = {
    kind: "ready",
  }
) {
  return Promise.resolve({ success: true as const, data: result });
}

function resolveArchiveResult(
  result: { kind: "archived" } | { kind: "confirm-lossy-untracked-files"; paths: string[] } = {
    kind: "archived",
  }
) {
  return Promise.resolve({ success: true as const, data: result });
}

type ArchiveConfirmationResult =
  | { kind: "archived" }
  | { kind: "confirm-lossy-untracked-files"; paths: string[] };
type ArchivePreflightConfirmationResult =
  | { kind: "ready" }
  | { kind: "confirm-lossy-untracked-files"; paths: string[] };
interface ArchiveWorkspaceActionResult {
  success: boolean;
  error?: string;
  data?: ArchiveConfirmationResult;
}
interface ArchivePreflightActionResult {
  success: boolean;
  error?: string;
  data?: ArchivePreflightConfirmationResult;
}

let preflightArchiveWorkspaceMock = mock(
  (_workspaceId: string): Promise<ArchivePreflightActionResult> => resolveArchivePreflight()
);
let archiveWorkspaceMock = mock(
  (
    _workspaceId: string,
    _options?: { acknowledgedUntrackedPaths?: string[] }
  ): Promise<ArchiveWorkspaceActionResult> => resolveArchiveResult()
);
let archiveShowErrorMock = mock(() => undefined);

// Timeline gate control. useExperimentValue must be module-mocked, not driven through
// localStorage: bun module mocks are process-global, so another test file's leaked
// useExperiments mock would otherwise override the real hook and poison these gates.
let mockTimelineExperimentEnabled = false;

function installWorkspaceMenuBarTestDoubles() {
  const actualExperiments =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/browser/hooks/useExperiments?real=1") as typeof ExperimentsModuleType;
  void mock.module("@/browser/hooks/useExperiments", () => ({
    ...actualExperiments,
    useExperimentValue: (experimentId: string) =>
      experimentId === EXPERIMENT_IDS.TIMELINE && mockTimelineExperimentEnabled,
  }));

  preflightArchiveWorkspaceMock = mock(
    (_workspaceId: string): Promise<ArchivePreflightActionResult> => resolveArchivePreflight()
  );
  archiveWorkspaceMock = mock(
    (
      _workspaceId: string,
      _options?: { acknowledgedUntrackedPaths?: string[] }
    ): Promise<ArchiveWorkspaceActionResult> => resolveArchiveResult()
  );
  archiveShowErrorMock = mock(() => undefined);

  spyOn(APIModule, "useAPI").mockImplementation(
    () => ({ api: null }) as unknown as ReturnType<typeof APIModule.useAPI>
  );
  spyOn(AgentContextModule, "useAgent").mockImplementation(
    () =>
      ({ disableWorkspaceAgents: false }) as unknown as ReturnType<
        typeof AgentContextModule.useAgent
      >
  );
  spyOn(WorkspaceContextModule, "useWorkspaceActions").mockImplementation(
    () =>
      ({
        archivingWorkspaceIds,
        preflightArchiveWorkspace: preflightArchiveWorkspaceMock,
        archiveWorkspace: archiveWorkspaceMock,
      }) as unknown as ReturnType<typeof WorkspaceContextModule.useWorkspaceActions>
  );
  spyOn(WorkspaceContextModule, "useWorkspaceContext").mockImplementation(
    () =>
      ({ workspaceMetadata }) as unknown as ReturnType<
        typeof WorkspaceContextModule.useWorkspaceContext
      >
  );
  spyOn(ProjectContextModule, "useProjectContext").mockImplementation(
    () =>
      ({
        getProjectConfig: () => undefined,
        userProjects: new Map(),
      }) as unknown as ReturnType<typeof ProjectContextModule.useProjectContext>
  );
  spyOn(WorkspaceStoreModule, "useWorkspaceSidebarState").mockImplementation(
    () =>
      ({
        canInterrupt: false,
        isStarting: false,
        awaitingUserQuestion: false,
        loadedSkills: [],
        skillLoadErrors: [],
      }) as unknown as ReturnType<typeof WorkspaceStoreModule.useWorkspaceSidebarState>
  );
  spyOn(RuntimeStatusStoreModule, "useRuntimeStatus").mockImplementation(() => "unsupported");
  spyOn(RuntimeStatusStoreModule, "useRuntimeStatusStoreRaw").mockImplementation(
    () =>
      ({ invalidateWorkspace: () => undefined }) as unknown as ReturnType<
        typeof RuntimeStatusStoreModule.useRuntimeStatusStoreRaw
      >
  );
  spyOn(OpenTerminalModule, "useOpenTerminal").mockImplementation(() =>
    mock(() => Promise.resolve())
  );
  spyOn(OpenInEditorModule, "useOpenInEditor").mockImplementation(() =>
    mock(() => Promise.resolve({ success: true }))
  );
  spyOn(PersistedStateModule, "usePersistedState").mockImplementation(
    <T,>(_key: string, defaultValue: T) => [defaultValue, mock(() => undefined)] as const
  );
  spyOn(PopoverErrorHookModule, "usePopoverError").mockImplementation(
    () =>
      ({
        error: null,
        showError: archiveShowErrorMock,
        clearError: () => undefined,
      }) as unknown as ReturnType<typeof PopoverErrorHookModule.usePopoverError>
  );
  spyOn(DesktopTitlebarModule, "isDesktopMode").mockImplementation(() => false);
  spyOn(TutorialContextModule, "useTutorial").mockImplementation(
    () =>
      ({ startSequence: () => undefined }) as unknown as ReturnType<
        typeof TutorialContextModule.useTutorial
      >
  );
  spyOn(ChatCommandsModule, "forkWorkspace").mockImplementation(() =>
    Promise.resolve({ success: true as const })
  );

  spyOn(WorkspaceMCPModalModule, "WorkspaceMCPModal").mockImplementation(
    (() => null) as unknown as typeof WorkspaceMCPModalModule.WorkspaceMCPModal
  );
  spyOn(TooltipModule, "Tooltip").mockImplementation(
    TestWrapper as unknown as typeof TooltipModule.Tooltip
  );
  spyOn(TooltipModule, "TooltipTrigger").mockImplementation(
    TestWrapper as unknown as typeof TooltipModule.TooltipTrigger
  );
  spyOn(TooltipModule, "TooltipContent").mockImplementation(
    (() => null) as unknown as typeof TooltipModule.TooltipContent
  );
  spyOn(PopoverModule, "Popover").mockImplementation(
    TestWrapper as unknown as typeof PopoverModule.Popover
  );
  spyOn(PopoverModule, "PopoverTrigger").mockImplementation(
    TestWrapper as unknown as typeof PopoverModule.PopoverTrigger
  );
  spyOn(PopoverModule, "PopoverContent").mockImplementation(
    TestWrapper as unknown as typeof PopoverModule.PopoverContent
  );
  spyOn(CheckboxModule, "Checkbox").mockImplementation(
    (() => null) as unknown as typeof CheckboxModule.Checkbox
  );
  spyOn(DebugLlmRequestModalModule, "DebugLlmRequestModal").mockImplementation(
    (() => null) as unknown as typeof DebugLlmRequestModalModule.DebugLlmRequestModal
  );
  spyOn(ConfirmationModalModule, "ConfirmationModal").mockImplementation(((props: {
    isOpen: boolean;
    title: string;
    description?: React.ReactNode;
    warning?: React.ReactNode;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    props.isOpen ? (
      <div data-testid="archive-confirmation-modal">
        <div>{props.title}</div>
        {props.description}
        {props.warning}
        <button type="button" onClick={props.onConfirm}>
          {props.confirmLabel ?? "Confirm"}
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    ) : null) as unknown as typeof ConfirmationModalModule.ConfirmationModal);
  spyOn(PopoverErrorModule, "PopoverError").mockImplementation(
    (() => null) as unknown as typeof PopoverErrorModule.PopoverError
  );
  spyOn(WorkspaceActionsMenuContentModule, "WorkspaceActionsMenuContent").mockImplementation(
    ((props: { onArchiveChat?: ((anchorEl: HTMLElement) => void) | null }) =>
      props.onArchiveChat ? (
        <button type="button" onClick={(event) => props.onArchiveChat?.(event.currentTarget)}>
          Archive chat
        </button>
      ) : null) as unknown as typeof WorkspaceActionsMenuContentModule.WorkspaceActionsMenuContent
  );
  spyOn(WorkspaceTerminalIconModule, "WorkspaceTerminalIcon").mockImplementation(
    (() => null) as unknown as typeof WorkspaceTerminalIconModule.WorkspaceTerminalIcon
  );
  spyOn(SkillIndicatorModule, "SkillIndicator").mockImplementation(
    (() => null) as unknown as typeof SkillIndicatorModule.SkillIndicator
  );
  spyOn(TimelineDialogModule, "TimelineDialog").mockImplementation(
    (() => null) as unknown as typeof TimelineDialogModule.TimelineDialog
  );
}

// Records render props like the WorkspaceActionsMenuContent double, so tests can
// assert the dialog opened without rendering the real timeline panel.
function getLastTimelineDialogProps() {
  const spy = TimelineDialogModule.TimelineDialog as unknown as {
    mock: { calls: Array<[{ workspaceId: string; open: boolean }]> };
  };
  return spy.mock.calls.at(-1)?.[0];
}

/**
 * Replace window.matchMedia so viewport-gated actions can be exercised per test.
 * `matches` is re-read on every access and registered change listeners are returned
 * so tests can simulate live viewport transitions.
 */
function stubMatchMedia(matches: (query: string) => boolean) {
  const changeListeners: Array<() => void> = [];
  window.matchMedia = ((query: string) =>
    ({
      get matches() {
        return matches(query);
      },
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (_type: string, listener: () => void) => {
        changeListeners.push(listener);
      },
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  return {
    fireChange: () => {
      for (const listener of changeListeners) {
        listener();
      }
    },
  };
}

const defaultProps: ComponentProps<typeof WorkspaceMenuBarComponent> = {
  workspaceId,
  projectName: "demo",
  projectPath: "/projects/demo",
  workspaceName: "feature-branch",
  workspaceTitle: "Feature branch",
  namedWorkspacePath: "/projects/demo/workspaces/feature-branch",
  runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
  leftSidebarCollapsed: false,
  onToggleLeftSidebarCollapsed: () => undefined,
};

describe("WorkspaceMenuBar archive confirmations", () => {
  beforeEach(() => {
    workspaceMetadata = new Map();
    archivingWorkspaceIds = new Set();
    mockTimelineExperimentEnabled = false;
    cleanupDom = installDom();
    installWorkspaceMenuBarTestDoubles();
    /* eslint-disable @typescript-eslint/no-require-imports */
    ({ WorkspaceMenuBar } = require("./WorkspaceMenuBar?workspace-menu-bar-test=1") as {
      WorkspaceMenuBar: typeof WorkspaceMenuBarComponent;
    });
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (!window.matchMedia) {
      window.matchMedia = (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: (_listener) => undefined,
        removeListener: (_listener) => undefined,
        addEventListener: (
          _type: string,
          _listener: EventListenerOrEventListenerObject | null,
          _options?: boolean | AddEventListenerOptions
        ) => undefined,
        removeEventListener: (
          _type: string,
          _listener: EventListenerOrEventListenerObject | null,
          _options?: boolean | EventListenerOptions
        ) => undefined,
        dispatchEvent: (_event) => false,
      });
    }
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("hides repo-dependent More-menu actions for scratch workspaces", () => {
    const scratchPath = "/home/user/.mux/scratch/workspace-1";
    workspaceMetadata.set(workspaceId, {
      kind: "scratch",
      id: workspaceId,
      name: "scratch-workspace-1",
      projectName: "Scratch",
      projectPath: scratchPath,
      namedWorkspacePath: scratchPath,
      runtimeConfig: { type: "local" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const view = render(
      <WorkspaceMenuBar
        {...defaultProps}
        projectName="Scratch"
        projectPath={scratchPath}
        workspaceName="scratch-workspace-1"
        namedWorkspacePath={scratchPath}
        runtimeConfig={{ type: "local" }}
      />
    );

    expect(view.getByTestId("workspace-title").textContent).toBe("Feature branch");

    // Repo-dependent More-menu actions must be hidden: review events are
    // ignored by RightSidebar for scratch and forking scratch is unsupported.
    const scratchMenuProps = getLastMenuContentProps();
    expect(scratchMenuProps?.onForkChat).toBeNull();
    expect(scratchMenuProps?.onEnterImmersiveReview).toBeNull();
    expect(scratchMenuProps?.onOpenTouchFullscreenReview).toBeNull();
  });

  it("shows the archiving status only while this workspace has an archive request in flight", () => {
    archivingWorkspaceIds = new Set(["some-other-workspace"]);
    const idle = render(<WorkspaceMenuBar {...defaultProps} />);
    expect(idle.queryByTestId("workspace-archiving-status")).toBeNull();
    idle.unmount();

    archivingWorkspaceIds = new Set([workspaceId]);
    const archiving = render(<WorkspaceMenuBar {...defaultProps} />);
    expect(archiving.getByTestId("workspace-archiving-status")).not.toBeNull();
  });

  it("offers fork and immersive review in the More menu for repo-backed workspaces", () => {
    workspaceMetadata.set(workspaceId, {
      id: workspaceId,
      name: "feature-branch",
      projectName: "demo",
      projectPath: "/projects/demo",
      namedWorkspacePath: "/projects/demo/workspaces/feature-branch",
      runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    render(<WorkspaceMenuBar {...defaultProps} />);

    const menuProps = getLastMenuContentProps();
    expect(typeof menuProps?.onForkChat).toBe("function");
    expect(typeof menuProps?.onEnterImmersiveReview).toBe("function");
  });

  it("offers the Timeline action on narrow viewports and opens the dialog", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia((query) => query === `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`);

    render(<WorkspaceMenuBar {...defaultProps} />);

    const menuProps = getLastMenuContentProps();
    expect(typeof menuProps?.onOpenTimeline).toBe("function");

    act(() => {
      menuProps?.onOpenTimeline?.();
    });

    const dialogProps = getLastTimelineDialogProps();
    expect(dialogProps?.open).toBe(true);
    expect(dialogProps?.workspaceId).toBe(workspaceId);
  });

  it("hides the Timeline action on wide viewports", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia(() => false);

    render(<WorkspaceMenuBar {...defaultProps} />);

    expect(getLastMenuContentProps()?.onOpenTimeline).toBeNull();
  });

  it("hides the Timeline action when the timeline experiment is disabled", () => {
    stubMatchMedia((query) => query === `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`);

    render(<WorkspaceMenuBar {...defaultProps} />);

    expect(getLastMenuContentProps()?.onOpenTimeline).toBeNull();
  });

  it("offers the Timeline action when the shell container hides the sidebar at wide viewports", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia(() => false);

    // Mimic WorkspaceShell: the shell wraps the menu bar and a CSS-hidden right sidebar
    // (the <=684px container query), which the gate reads via computed style.
    const shell = document.createElement("div");
    shell.setAttribute("data-workspace-shell", "");
    document.body.appendChild(shell);
    const sidebar = document.createElement("div");
    sidebar.className = "mobile-hide-right-sidebar";
    sidebar.style.display = "none";
    shell.appendChild(sidebar);
    const mount = document.createElement("div");
    shell.appendChild(mount);

    render(<WorkspaceMenuBar {...defaultProps} />, { container: mount });

    expect(typeof getLastMenuContentProps()?.onOpenTimeline).toBe("function");
    shell.remove();
  });

  it("re-gates the Timeline action when the viewport crosses the narrow breakpoint", () => {
    mockTimelineExperimentEnabled = true;
    let narrow = false;
    const media = stubMatchMedia(
      (query) => narrow && query === `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`
    );

    render(<WorkspaceMenuBar {...defaultProps} />);
    expect(getLastMenuContentProps()?.onOpenTimeline).toBeNull();

    narrow = true;
    act(() => {
      media.fireChange();
    });

    expect(typeof getLastMenuContentProps()?.onOpenTimeline).toBe("function");
  });

  it("opens the timeline dialog with the keyboard shortcut on narrow viewports", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia((query) => query === `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`);

    render(<WorkspaceMenuBar {...defaultProps} />);

    act(() => {
      fireEvent.keyDown(window, { key: "T", shiftKey: true });
    });

    const dialogProps = getLastTimelineDialogProps();
    expect(dialogProps?.open).toBe(true);
  });

  it("ignores the timeline shortcut while the sidebar is visible", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia(() => false);

    render(<WorkspaceMenuBar {...defaultProps} />);

    act(() => {
      fireEvent.keyDown(window, { key: "T", shiftKey: true });
    });

    expect(getLastTimelineDialogProps()?.open).toBe(false);
  });

  it("ignores the timeline shortcut while another modal is open", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia((query) => query === `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`);

    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);

    render(<WorkspaceMenuBar {...defaultProps} />);

    act(() => {
      fireEvent.keyDown(window, { key: "T", shiftKey: true });
    });

    expect(getLastTimelineDialogProps()?.open).toBe(false);
    modal.remove();
  });

  it("closes the timeline dialog when switching workspaces", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia((query) => query === `(max-width: ${NARROW_VIEWPORT_MAX_WIDTH_PX}px)`);

    const view = render(<WorkspaceMenuBar {...defaultProps} />);

    act(() => {
      fireEvent.keyDown(window, { key: "T", shiftKey: true });
    });
    expect(getLastTimelineDialogProps()?.open).toBe(true);

    // The timeline's "Open child workspace" action swaps the selected workspace while
    // App reuses this menu bar instance; the dialog must not cover the new workspace.
    view.rerender(<WorkspaceMenuBar {...defaultProps} workspaceId="workspace-2" />);

    expect(getLastTimelineDialogProps()?.open).toBe(false);

    // Returning to the original workspace must not resurrect the dialog: the
    // retained id is cleared on leave, not merely masked by the comparison.
    view.rerender(<WorkspaceMenuBar {...defaultProps} />);

    expect(getLastTimelineDialogProps()?.open).toBe(false);
  });

  it("keeps the Timeline action hidden when immersive review hides the sidebar", () => {
    mockTimelineExperimentEnabled = true;
    stubMatchMedia(() => false);

    // Immersive review hides the sidebar via the same display:none but marks it
    // aria-hidden; the gate must not treat that as a responsive (narrow) layout.
    const shell = document.createElement("div");
    shell.setAttribute("data-workspace-shell", "");
    document.body.appendChild(shell);
    const sidebar = document.createElement("div");
    sidebar.className = "mobile-hide-right-sidebar";
    sidebar.style.display = "none";
    sidebar.setAttribute("aria-hidden", "true");
    shell.appendChild(sidebar);
    const mount = document.createElement("div");
    shell.appendChild(mount);

    render(<WorkspaceMenuBar {...defaultProps} />, { container: mount });

    expect(getLastMenuContentProps()?.onOpenTimeline).toBeNull();

    act(() => {
      fireEvent.keyDown(window, { key: "T", shiftKey: true });
    });
    expect(getLastTimelineDialogProps()?.open).toBe(false);
    shell.remove();
  });

  it("applies the collapsed-left-sidebar inset immediately from props", () => {
    const view = render(<WorkspaceMenuBar {...defaultProps} leftSidebarCollapsed />);

    expect(view.getByTestId("workspace-menu-bar").style.paddingLeft).toBe(
      `${WORKSPACE_MENU_BAR_LEFT_SIDEBAR_COLLAPSED_PADDING_PX}px`
    );
  });

  it("opens the archive confirmation modal when preflight finds untracked files", async () => {
    preflightArchiveWorkspaceMock = mock(
      (_workspaceId: string): Promise<ArchivePreflightActionResult> =>
        resolveArchivePreflight({
          kind: "confirm-lossy-untracked-files",
          paths: [".cache/", "temp.txt"],
        })
    );

    const view = render(<WorkspaceMenuBar {...defaultProps} />);

    act(() => {
      fireEvent.click(view.getByRole("button", { name: "Archive chat" }));
    });

    await waitFor(() => {
      expect(view.getByTestId("archive-confirmation-modal")).toBeTruthy();
    });
    expect(archiveWorkspaceMock).not.toHaveBeenCalled();
    expect(view.getByText("Archive workspace with untracked files?")).toBeTruthy();
  });

  it("reopens the archive confirmation modal when archive finds new untracked files", async () => {
    let archiveAttempt = 0;
    archiveWorkspaceMock = mock(
      (
        id: string,
        options?: { acknowledgedUntrackedPaths?: string[] }
      ): Promise<ArchiveWorkspaceActionResult> => {
        archiveAttempt += 1;
        if (archiveAttempt === 1) {
          return resolveArchiveResult({
            kind: "confirm-lossy-untracked-files",
            paths: ["late-file.txt"],
          });
        }

        expect(id).toBe(workspaceId);
        expect(options).toEqual({ acknowledgedUntrackedPaths: ["late-file.txt"] });
        return resolveArchiveResult({ kind: "archived" });
      }
    );

    const view = render(<WorkspaceMenuBar {...defaultProps} />);

    act(() => {
      fireEvent.click(view.getByRole("button", { name: "Archive chat" }));
    });

    await waitFor(() => {
      expect(view.getByTestId("archive-confirmation-modal")).toBeTruthy();
    });
    expect(archiveShowErrorMock).not.toHaveBeenCalled();
    expect(archiveWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(archiveWorkspaceMock).toHaveBeenNthCalledWith(1, workspaceId, undefined);

    act(() => {
      fireEvent.click(view.getByRole("button", { name: "Archive and delete files" }));
    });

    await waitFor(() => {
      expect(archiveWorkspaceMock).toHaveBeenCalledTimes(2);
    });
    expect(archiveWorkspaceMock).toHaveBeenNthCalledWith(2, workspaceId, {
      acknowledgedUntrackedPaths: ["late-file.txt"],
    });
    expect(archiveShowErrorMock).not.toHaveBeenCalled();
  });
});
