import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../tests/ui/dom";
import type * as ReactDndModuleType from "react-dnd";
import type * as ReactDndHtml5BackendModuleType from "react-dnd-html5-backend";
import type * as APIModuleType from "@/browser/contexts/API";
import type * as ProjectContextModuleType from "@/browser/contexts/ProjectContext";
import type * as WorkspaceTitleEditContextModuleType from "@/browser/contexts/WorkspaceTitleEditContext";
import type * as ContextMenuPositionModuleType from "@/browser/hooks/useContextMenuPosition";
import type * as ExperimentsModuleType from "@/browser/hooks/useExperiments";
import type * as WorkspaceFallbackModelModuleType from "@/browser/hooks/useWorkspaceFallbackModel";
import type * as WorkspaceUnreadModule from "@/browser/hooks/useWorkspaceUnread";
import type * as RuntimeStatusStoreModuleType from "@/browser/stores/RuntimeStatusStore";
import type * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as TooltipModule from "../Tooltip/Tooltip";
import * as WorkspaceStatusIndicatorModule from "../WorkspaceStatusIndicator/WorkspaceStatusIndicator";
import type {
  AgentRowRenderMeta,
  WorkspaceDelegatedActivity,
  WorkspaceSubAgentsSummary,
} from "@/browser/utils/ui/workspaceFiltering";
import type { StreamAbortReasonSnapshot } from "@/common/types/stream";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { WorkspaceSelection } from "./AgentListItem";
import type { AgentListItem as AgentListItemComponent } from "./AgentListItem";

let AgentListItem!: typeof AgentListItemComponent;

const TEST_WORKSPACE_ID = "workspace-archiving";
const TEST_WORKSPACE_TITLE = "Archiving Workspace";
const HEARTBEAT_INTERVAL_MS = 60_000;
const SUBAGENT_ROW_META: AgentRowRenderMeta = {
  depth: 1,
  rowKind: "subagent",
  connectorPosition: "single",
  connectorStartsAtParent: true,
  sharedTrunkActiveThroughRow: false,
  sharedTrunkActiveBelowRow: false,
  ancestorTrunks: [],
  hasHiddenCompletedChildren: false,
  visibleCompletedChildrenCount: 0,
};

type MockWorkspaceUnreadState = ReturnType<typeof WorkspaceUnreadModule.useWorkspaceUnread>;
type MockWorkspaceSidebarState = ReturnType<typeof WorkspaceStoreModule.useWorkspaceSidebarState>;

let mockWorkspaceHeartbeatsEnabled = false;
let latestUseDragSpec: (() => { item?: () => Record<string, unknown> }) | null = null;
let mockWorkspaceUnreadState: MockWorkspaceUnreadState;
let mockWorkspaceSidebarState: MockWorkspaceSidebarState;

function createWorkspaceUnreadState(
  overrides: Partial<MockWorkspaceUnreadState> = {}
): MockWorkspaceUnreadState {
  return {
    isUnread: false,
    lastReadTimestamp: null,
    recencyTimestamp: null,
    ...overrides,
  };
}

function createWorkspaceSidebarState(
  overrides: Partial<MockWorkspaceSidebarState> = {}
): MockWorkspaceSidebarState {
  return {
    canInterrupt: false,
    isStarting: false,
    awaitingUserQuestion: false,
    lastAbortReason: null,
    currentModel: null,
    pendingStreamModel: null,
    recencyTimestamp: null,
    loadedSkills: [],
    skillLoadErrors: [],
    agentStatus: undefined,
    activeWorkflowRunCount: 0,
    activeBashMonitorCount: 0,
    terminalActiveCount: 0,
    terminalSessionCount: 0,
    ...overrides,
  };
}

function makeHiddenSummary(
  overrides: Partial<WorkspaceSubAgentsSummary> = {}
): WorkspaceSubAgentsSummary {
  return {
    subAgentCount: 0,
    runningSubAgentCount: 0,
    queuedSubAgentCount: 0,
    runningWorkflowRunCount: 0,
    queuedWorkflowRunCount: 0,
    runningWorkflowAgentCount: 0,
    queuedWorkflowAgentCount: 0,
    workflowRunIds: new Set(),
    ...overrides,
  };
}

function createMetadata(
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id: TEST_WORKSPACE_ID,
    name: "archiving-workspace",
    title: TEST_WORKSPACE_TITLE,
    projectName: "Project",
    projectPath: "/tmp/project",
    namedWorkspacePath: "/tmp/project/archiving-workspace",
    runtimeConfig: { type: "local" },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createSystemAbortReason(): StreamAbortReasonSnapshot {
  return {
    reason: "system",
    at: Date.now(),
  };
}

function createHeartbeatMetadata(overrides: Partial<FrontendWorkspaceMetadata["heartbeat"]> = {}) {
  return createMetadata({
    heartbeat: { enabled: true, intervalMs: HEARTBEAT_INTERVAL_MS, ...overrides },
  });
}

function installAgentListItemTestDoubles() {
  const passthroughRef = <T,>(value: T): T => value;

  spyOn(TooltipModule, "Tooltip").mockImplementation(((props: { children: ReactNode }) => (
    <>{props.children}</>
  )) as unknown as typeof TooltipModule.Tooltip);
  spyOn(TooltipModule, "TooltipTrigger").mockImplementation(((props: { children: ReactNode }) => (
    <>{props.children}</>
  )) as unknown as typeof TooltipModule.TooltipTrigger);
  spyOn(TooltipModule, "TooltipContent").mockImplementation(((props: { children: ReactNode }) => (
    <>{props.children}</>
  )) as unknown as typeof TooltipModule.TooltipContent);
  spyOn(TooltipModule, "TooltipIfPresent").mockImplementation(((props: {
    children: ReactNode;
    tooltip?: string;
  }) => (
    <span data-testid="badge-tooltip" data-tooltip-content={props.tooltip}>
      {props.children}
    </span>
  )) as unknown as typeof TooltipModule.TooltipIfPresent);
  spyOn(WorkspaceStatusIndicatorModule, "WorkspaceStatusIndicator").mockImplementation(((props: {
    workspaceId: string;
  }) => (
    <div data-testid={`workspace-status-indicator-${props.workspaceId}`} />
  )) as unknown as typeof WorkspaceStatusIndicatorModule.WorkspaceStatusIndicator);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const actualReactDnd = require("react-dnd?real=1") as typeof ReactDndModuleType;
  const actualReactDndHtml5Backend =
    require("react-dnd-html5-backend?real=1") as typeof ReactDndHtml5BackendModuleType;
  const actualApi = require("@/browser/contexts/API?real=1") as typeof APIModuleType;
  const actualProjectContext =
    require("@/browser/contexts/ProjectContext?real=1") as typeof ProjectContextModuleType;
  const actualWorkspaceTitleEditContext =
    require("@/browser/contexts/WorkspaceTitleEditContext?real=1") as typeof WorkspaceTitleEditContextModuleType;
  const actualContextMenuPosition =
    require("@/browser/hooks/useContextMenuPosition?real=1") as typeof ContextMenuPositionModuleType;
  const actualExperiments =
    require("@/browser/hooks/useExperiments?real=1") as typeof ExperimentsModuleType;
  const actualWorkspaceUnread =
    require("@/browser/hooks/useWorkspaceUnread?real=1") as typeof WorkspaceUnreadModule;
  const actualRuntimeStatusStore =
    require("@/browser/stores/RuntimeStatusStore?real=1") as typeof RuntimeStatusStoreModuleType;
  const actualWorkspaceFallbackModel =
    require("@/browser/hooks/useWorkspaceFallbackModel?real=1") as typeof WorkspaceFallbackModelModuleType;
  const actualWorkspaceStore =
    require("@/browser/stores/WorkspaceStore?real=1") as typeof WorkspaceStoreModule;
  /* eslint-enable @typescript-eslint/no-require-imports */

  void mock.module("react-dnd", () => ({
    ...actualReactDnd,
    useDrag: (spec: () => { item?: () => Record<string, unknown> }) => {
      latestUseDragSpec = spec;
      return [{ isDragging: false }, passthroughRef, () => undefined] as const;
    },
    useDrop: () => [{ isPinnedReorderTarget: false }, passthroughRef] as const,
  }));

  void mock.module("react-dnd-html5-backend", () => ({
    ...actualReactDndHtml5Backend,
    getEmptyImage: () => new Image(),
  }));

  void mock.module("@/browser/contexts/API", () => ({
    ...actualApi,
    useAPI: () => ({
      api: null,
      status: "error" as const,
      error: "API unavailable",
      authenticate: () => undefined,
      retry: () => undefined,
    }),
  }));

  void mock.module("@/browser/contexts/ProjectContext", () => ({
    ...actualProjectContext,
    useProjectContext: () => ({
      getProjectConfig: () => undefined,
      userProjects: new Map(),
    }),
  }));

  void mock.module("@/browser/contexts/WorkspaceTitleEditContext", () => ({
    ...actualWorkspaceTitleEditContext,
    useTitleEdit: () => ({
      editingWorkspaceId: null,
      requestEdit: () => true,
      confirmEdit: () => Promise.resolve({ success: true }),
      cancelEdit: () => undefined,
      generatingTitleWorkspaceIds: new Set<string>(),
      wrapGenerateTitle: () => undefined,
    }),
  }));

  void mock.module("../WorkspaceHeartbeatModal", () => ({
    WorkspaceHeartbeatModal: () => null,
  }));

  void mock.module("@/browser/hooks/useContextMenuPosition", () => ({
    ...actualContextMenuPosition,
    useContextMenuPosition: () => ({
      position: null,
      isOpen: false,
      onContextMenu: () => undefined,
      onOpenChange: () => undefined,
      touchHandlers: {
        onTouchStart: () => undefined,
        onTouchEnd: () => undefined,
        onTouchMove: () => undefined,
      },
      suppressClickIfLongPress: () => false,
      close: () => undefined,
    }),
  }));

  void mock.module("@/browser/hooks/useExperiments", () => ({
    ...actualExperiments,
    useExperimentValue: () => mockWorkspaceHeartbeatsEnabled,
  }));

  void mock.module("@/browser/hooks/useWorkspaceUnread", () => ({
    ...actualWorkspaceUnread,
    useWorkspaceUnread: () => mockWorkspaceUnreadState,
  }));

  void mock.module("@/browser/stores/RuntimeStatusStore", () => ({
    ...actualRuntimeStatusStore,
    useRuntimeStatus: () => null,
  }));

  void mock.module("@/browser/hooks/useWorkspaceFallbackModel", () => ({
    ...actualWorkspaceFallbackModel,
    useWorkspaceFallbackModel: () => "claude-sonnet-4-5",
  }));

  void mock.module("@/browser/stores/WorkspaceStore", () => ({
    ...actualWorkspaceStore,
    useWorkspaceSidebarState: () => mockWorkspaceSidebarState,
  }));
}

function renderWorkspaceItem(
  options: {
    metadata?: FrontendWorkspaceMetadata;
    isSelected?: boolean;
    isArchiving?: boolean;
    depth?: number;
    rowRenderMeta?: AgentRowRenderMeta;
    subAgentConnectorLayout?: "default" | "task-group-member";
    taskGroupHeaderTitle?: string;
    isWorkspaceLiveActive?: boolean;
    delegatedActivity?: WorkspaceDelegatedActivity;
    hiddenSubAgentsSummary?: WorkspaceSubAgentsSummary;
    getWorkflowRunName?: (runId: string) => string | undefined;
    completedChildrenExpanded?: boolean;
    onToggleCompletedChildren?: (workspaceId: string) => void;
    onSelectWorkspace?: (selection: WorkspaceSelection) => void;
    projectBadgeName?: string;
  } = {}
) {
  const metadata = options.metadata ?? createMetadata();
  const view = render(
    <AgentListItem
      metadata={metadata}
      projectPath={metadata.projectPath}
      projectName={metadata.projectName}
      projectBadgeName={options.projectBadgeName}
      isSelected={options.isSelected ?? false}
      isArchiving={options.isArchiving}
      depth={options.depth ?? options.rowRenderMeta?.depth}
      rowRenderMeta={options.rowRenderMeta}
      subAgentConnectorLayout={options.subAgentConnectorLayout}
      taskGroupHeaderTitle={options.taskGroupHeaderTitle}
      isWorkspaceLiveActive={options.isWorkspaceLiveActive}
      delegatedActivity={options.delegatedActivity}
      hiddenSubAgentsSummary={options.hiddenSubAgentsSummary}
      getWorkflowRunName={options.getWorkflowRunName}
      completedChildrenExpanded={options.completedChildrenExpanded}
      onToggleCompletedChildren={options.onToggleCompletedChildren}
      onSelectWorkspace={options.onSelectWorkspace ?? (() => undefined)}
      onForkWorkspace={() => Promise.resolve()}
      onArchiveWorkspace={() => Promise.resolve()}
      onCancelCreation={() => Promise.resolve()}
    />
  );

  return {
    metadata,
    view,
    // Lazy: D8 title suppression changes the accessible name for group-member
    // rows, so only resolve the default lookup when a test actually uses it.
    get row() {
      return view.getByRole("button", {
        name: `${options.isArchiving ? "Archiving" : "Select"} workspace ${metadata.title ?? metadata.name}`,
      });
    },
  };
}

describe("AgentListItem", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    mockWorkspaceHeartbeatsEnabled = false;
    mockWorkspaceUnreadState = createWorkspaceUnreadState();
    mockWorkspaceSidebarState = createWorkspaceSidebarState();
    installAgentListItemTestDoubles();
    /* eslint-disable @typescript-eslint/no-require-imports */
    ({ AgentListItem } = require("./AgentListItem?agent-list-item-test=1") as {
      AgentListItem: typeof AgentListItemComponent;
    });
    /* eslint-enable @typescript-eslint/no-require-imports */
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("exposes the full project badge label through the shared tooltip", () => {
    // The badge's width cap end-truncates hierarchical "Parent / Sub" names,
    // so the shared tooltip wrapper must carry the full label.
    const badgeName = "Parent Project With A Long Name / Frontend";
    const { view } = renderWorkspaceItem({ projectBadgeName: badgeName });

    const badge = view.getByTestId(`workspace-project-badge-${TEST_WORKSPACE_ID}`);
    const tooltip = badge.closest('[data-testid="badge-tooltip"]');
    expect(tooltip?.getAttribute("data-tooltip-content")).toBe(badgeName);
  });

  test("falls back to the row's sub-project scope for drag section identity", () => {
    // Flat rows omit the sectionId prop (it also drives section indentation),
    // so the drag item must carry metadata.subProjectPath instead; drop zones
    // rely on it to treat same-section drops as no-ops.
    renderWorkspaceItem({
      metadata: createMetadata({ subProjectPath: "/tmp/project/features" }),
    });
    const item = latestUseDragSpec?.().item?.();
    expect(item?.workspaceId).toBe(TEST_WORKSPACE_ID);
    expect(item?.currentSectionId).toBe("/tmp/project/features");
  });

  test("suppresses best-of member titles that repeat the group header (D8)", () => {
    const candidate = renderWorkspaceItem({
      metadata: createMetadata({
        title: "Compare options",
        parentWorkspaceId: "parent",
        bestOf: { groupId: "g1", index: 0, total: 2 },
      }),
      subAgentConnectorLayout: "task-group-member",
      taskGroupHeaderTitle: "Compare options",
    });
    expect(
      candidate.view.getByRole("button", { name: "Select workspace Candidate A" })
    ).toBeTruthy();
    expect(candidate.view.queryByText("Compare options")).toBeNull();
    cleanup();

    // A custom (differing) title still renders alongside the candidate label.
    const customTitle = renderWorkspaceItem({
      metadata: createMetadata({
        title: "My renamed run",
        parentWorkspaceId: "parent",
        bestOf: { groupId: "g1", index: 1, total: 2 },
      }),
      subAgentConnectorLayout: "task-group-member",
      taskGroupHeaderTitle: "Compare options",
    });
    expect(
      customTitle.view.getByRole("button", {
        name: "Select workspace My renamed run, scope B",
      })
    ).toBeTruthy();
    expect(customTitle.view.getByText("My renamed run")).toBeTruthy();
    expect(customTitle.view.getByText("scope: B")).toBeTruthy();
  });

  test("shows workflow-only activity on idle workspace rows", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({ activeWorkflowRunCount: 1 });

    const { row } = renderWorkspaceItem();
    const rowView = within(row);

    expect(row.querySelector(".workspace-status-dot-active")).toBeTruthy();
    expect(rowView.getByText("Workflow running")).toBeTruthy();
    expect(rowView.queryByTestId(`workspace-status-indicator-${TEST_WORKSPACE_ID}`)).toBeNull();
  });

  test("keeps sidebar status text while workflow-only activity drives the active dot", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      activeWorkflowRunCount: 1,
      agentStatus: { emoji: "🔄", message: "Verifying workflow output" },
    });

    const { row } = renderWorkspaceItem();
    const rowView = within(row);

    expect(row.querySelector(".workspace-status-dot-active")).toBeTruthy();
    expect(rowView.getByTestId(`workspace-status-indicator-${TEST_WORKSPACE_ID}`)).toBeTruthy();
    expect(rowView.queryByText("Workflow running")).toBeNull();
  });

  test("shows armed background bash monitor activity on idle workspace rows", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({ activeBashMonitorCount: 1 });

    const { row } = renderWorkspaceItem();
    const rowView = within(row);

    // Waiting-on-monitor renders the backgrounded-blue dot (same pulse as the
    // active dot), NOT the green streaming dot — that ambiguity confused users.
    expect(row.querySelector(".bg-content-success")).toBeNull();
    expect(row.querySelector(".bg-backgrounded")).toBeTruthy();
    expect(rowView.getByText("Watching background bash")).toBeTruthy();
    expect(rowView.queryByTestId(`workspace-status-indicator-${TEST_WORKSPACE_ID}`)).toBeNull();
  });

  test("armed monitor status outranks delegated activity text", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({ activeBashMonitorCount: 1 });

    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 0,
        queuedCount: 1,
        workflowActiveCount: 0,
        workflowQueuedCount: 0,
      },
    });
    const rowView = within(row);

    // Own-workspace watching state wins over the delegated subtitle, mirroring
    // the workflow-status precedence.
    expect(rowView.getByText("Watching background bash")).toBeTruthy();
    expect(rowView.queryByTestId(`workspace-delegated-activity-${TEST_WORKSPACE_ID}`)).toBeNull();
  });

  test("keeps sidebar status text while an armed monitor drives the waiting dot", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      activeBashMonitorCount: 1,
      agentStatus: { emoji: "⌛", message: "Awaiting PR readiness check" },
    });

    const { row } = renderWorkspaceItem();
    const rowView = within(row);

    expect(row.querySelector(".bg-content-success")).toBeNull();
    expect(row.querySelector(".bg-backgrounded")).toBeTruthy();
    expect(rowView.getByTestId(`workspace-status-indicator-${TEST_WORKSPACE_ID}`)).toBeTruthy();
    expect(rowView.queryByText("Watching background bash")).toBeNull();
  });

  test("active streaming keeps the green dot even with an armed monitor", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      canInterrupt: true,
      activeBashMonitorCount: 1,
    });

    const { row } = renderWorkspaceItem();

    // Real streaming outranks the waiting-on-monitor blue.
    expect(row.querySelector(".bg-content-success")).toBeTruthy();
    expect(row.querySelector(".bg-backgrounded")).toBeNull();
  });

  test("shows active delegated workflow work on idle workspace rows", () => {
    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 2,
        queuedCount: 1,
        workflowActiveCount: 2,
        workflowQueuedCount: 1,
      },
    });
    const rowView = within(row);

    expect(row.querySelector(".workspace-status-dot-active")).toBeTruthy();
    expect(rowView.getByText("Workflow running · 2 sub-agents active · 1 queued")).toBeTruthy();
    const descriptionId = row.getAttribute("aria-describedby");
    expect(descriptionId).toBe(`workspace-status-description-${TEST_WORKSPACE_ID}`);
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain(
      "Workflow running · 2 sub-agents active · 1 queued"
    );
    expect(rowView.queryByTestId(`workspace-status-indicator-${TEST_WORKSPACE_ID}`)).toBeNull();
  });

  test("keeps coordinator streaming copy ahead of delegated workflow work", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({ canInterrupt: true });

    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 1,
        queuedCount: 0,
        workflowActiveCount: 1,
        workflowQueuedCount: 0,
      },
    });
    const rowView = within(row);

    expect(row.querySelector(".workspace-status-dot-active")).toBeTruthy();
    expect(rowView.getByTestId(`workspace-status-indicator-${TEST_WORKSPACE_ID}`)).toBeTruthy();
    expect(rowView.queryByText("Workflow running · 1 sub-agent active")).toBeNull();
  });

  test("keeps coordinator streaming copy ahead of active delegated work", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({ canInterrupt: true });

    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 1,
        queuedCount: 0,
        workflowActiveCount: 0,
        workflowQueuedCount: 0,
      },
    });
    const rowView = within(row);

    expect(row.querySelector(".workspace-status-dot-active")).toBeTruthy();
    expect(rowView.getByTestId(`workspace-status-indicator-${TEST_WORKSPACE_ID}`)).toBeTruthy();
    expect(rowView.queryByText("1 sub-agent active")).toBeNull();
  });

  test("keeps own question status ahead of delegated workflow work", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({ awaitingUserQuestion: true });

    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 1,
        queuedCount: 0,
        workflowActiveCount: 1,
        workflowQueuedCount: 0,
      },
    });
    const rowView = within(row);

    expect(row.querySelector(".bg-border-pending.border-surface-sky")).toBeTruthy();
    expect(rowView.getByText("Xum has a few questions")).toBeTruthy();
    expect(rowView.queryByText("Workflow running · 1 sub-agent active")).toBeNull();
  });

  test("shows queued delegated workflow work without marking the row active", () => {
    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 0,
        queuedCount: 1,
        workflowActiveCount: 0,
        workflowQueuedCount: 1,
      },
    });
    const rowView = within(row);

    expect(row.querySelector(".workspace-status-dot-active")).toBeNull();
    expect(rowView.getByText("Workflow queued · 1 sub-agent queued")).toBeTruthy();
  });

  test("keeps own system errors ahead of delegated workflow work", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      lastAbortReason: createSystemAbortReason(),
    });

    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 1,
        queuedCount: 0,
        workflowActiveCount: 1,
        workflowQueuedCount: 0,
      },
    });
    const rowView = within(row);

    expect(row.querySelector(".bg-content-destructive.border-surface-destructive")).toBeTruthy();
    expect(rowView.queryByText("Workflow running · 1 sub-agent active")).toBeNull();
  });

  test("summarizes hidden sub-agents with only the active count", () => {
    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 1,
        queuedCount: 0,
        workflowActiveCount: 0,
        workflowQueuedCount: 0,
      },
      hiddenSubAgentsSummary: makeHiddenSummary({ subAgentCount: 3, runningSubAgentCount: 1 }),
    });
    const rowView = within(row);

    expect(row.querySelector(".workspace-status-dot-active")).toBeTruthy();
    const indicator = rowView.getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`);
    expect(indicator.textContent).toBe("1 sub-agent active");
    expect(indicator.querySelector("svg")).toBeTruthy();
    expect(rowView.queryByTestId(`workspace-delegated-activity-${TEST_WORKSPACE_ID}`)).toBeNull();
  });

  test("summarizes a hidden workflow run with its name and agent count", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      activeWorkflowRunIds: ["run-1"],
      activeWorkflowRunCount: 1,
    });

    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({
        runningWorkflowRunCount: 1,
        runningWorkflowAgentCount: 5,
        workflowRunIds: new Set(["run-1"]),
        workflowName: "Deep Research",
      }),
    });
    const rowView = within(row);

    expect(rowView.getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent).toBe(
      "Deep Research running (5 agents)"
    );
    expect(rowView.queryByText("Workflow running")).toBeNull();
  });

  test("shows the workflow name and current step for a single running worker", () => {
    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({
        runningWorkflowRunCount: 1,
        runningWorkflowAgentCount: 1,
        workflowRunIds: new Set(["run-1"]),
        workflowName: "Deep Research",
        runningWorkflowStepTitle: "Implementer",
      }),
    });

    expect(
      within(row).getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent
    ).toBe("Deep Research · Implementer");
  });

  test("appends queued workers after the current step label", () => {
    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({
        runningWorkflowRunCount: 1,
        runningWorkflowAgentCount: 1,
        queuedWorkflowAgentCount: 2,
        workflowRunIds: new Set(["run-1"]),
        workflowName: "Deep Research",
        runningWorkflowStepTitle: "Implementer",
      }),
    });

    expect(
      within(row).getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent
    ).toBe("Deep Research · Implementer · 2 queued");
  });

  test("labels a lone gap-only run with its retained workflow name", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      activeWorkflowRunIds: ["run-gap"],
      activeWorkflowRunCount: 1,
    });

    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary(),
      getWorkflowRunName: (runId) => (runId === "run-gap" ? "Deep Research" : undefined),
    });

    expect(
      within(row).getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent
    ).toBe("Deep Research running");
  });

  test("shows the hidden sub-agents summary while the coordinator itself streams", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      canInterrupt: true,
      agentStatus: { emoji: "🔄", message: "Validating and packaging" },
    });

    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({ subAgentCount: 2, runningSubAgentCount: 2 }),
    });
    const rowView = within(row);

    expect(rowView.getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent).toBe(
      "2 sub-agents active"
    );
    expect(rowView.queryByTestId(`workspace-status-indicator-${TEST_WORKSPACE_ID}`)).toBeNull();
    // The row's own streaming state still shows through the green dot.
    expect(row.querySelector(".bg-content-success")).toBeTruthy();
  });

  test("shows the hidden sub-agents summary over an armed bash monitor", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({ activeBashMonitorCount: 1 });

    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({ subAgentCount: 2, runningSubAgentCount: 2 }),
    });
    const rowView = within(row);

    expect(rowView.getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent).toBe(
      "2 sub-agents active"
    );
    expect(rowView.queryByText("Watching background bash")).toBeNull();
  });

  test("distinguishes queued from running hidden sub-agents", () => {
    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({
        subAgentCount: 3,
        runningSubAgentCount: 1,
        queuedSubAgentCount: 2,
      }),
    });

    expect(
      within(row).getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent
    ).toBe("1 sub-agent active · 2 queued");
  });

  test("labels a workflow with only queued workers as queued, not running", () => {
    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({
        queuedWorkflowRunCount: 1,
        queuedWorkflowAgentCount: 2,
        workflowRunIds: new Set(["run-1"]),
        workflowName: "Deep Research",
      }),
    });

    expect(
      within(row).getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent
    ).toBe("Deep Research queued (2 agents)");
  });

  test("appends queued workflow workers after the running count", () => {
    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({
        runningWorkflowRunCount: 1,
        runningWorkflowAgentCount: 2,
        queuedWorkflowAgentCount: 1,
        workflowRunIds: new Set(["run-1"]),
        workflowName: "Deep Research",
      }),
    });

    expect(
      within(row).getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent
    ).toBe("Deep Research running (2 agents) · 1 queued");
  });

  test("does not count queued-only runs in the running workflow label", () => {
    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({
        runningWorkflowRunCount: 1,
        queuedWorkflowRunCount: 1,
        runningWorkflowAgentCount: 2,
        queuedWorkflowAgentCount: 1,
        workflowRunIds: new Set(["run-1", "run-2"]),
        workflowName: "Deep Research",
      }),
    });

    expect(
      within(row).getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent
    ).toBe("Deep Research running (2 agents) · 1 queued");
  });

  test("keeps a workflow line through step gaps when only the run itself is active", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      activeWorkflowRunIds: ["run-1"],
      activeWorkflowRunCount: 1,
    });

    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary(),
    });
    const rowView = within(row);

    const indicator = rowView.getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`);
    expect(indicator.textContent).toBe("Workflow running");
    expect(indicator.querySelector("svg")).toBeTruthy();
  });

  test("counts an own run in a step gap alongside a concurrent run's workers", () => {
    // run-2 is between steps (no live worker), so only the workspace's own
    // active run list knows about it; the label must not report just run-1.
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      activeWorkflowRunIds: ["run-1", "run-2"],
      activeWorkflowRunCount: 2,
    });

    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({
        runningWorkflowRunCount: 1,
        runningWorkflowAgentCount: 1,
        workflowRunIds: new Set(["run-1"]),
        workflowName: "Deep Research",
      }),
    });

    expect(
      within(row).getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent
    ).toBe("2 workflows running (1 agent)");
  });

  test("does not borrow a queued run's name for a gap-only running label", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      activeWorkflowRunIds: ["run-queued", "run-gap"],
      activeWorkflowRunCount: 2,
    });

    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({
        queuedWorkflowRunCount: 1,
        queuedWorkflowAgentCount: 2,
        workflowRunIds: new Set(["run-queued"]),
        workflowName: "Deep Research",
      }),
      getWorkflowRunName: (runId) => (runId === "run-queued" ? "Deep Research" : undefined),
    });

    expect(
      within(row).getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent
    ).toBe("Workflow running · 2 queued");
  });

  test("shows running sub-agents ahead of a queued-only workflow", () => {
    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({
        subAgentCount: 2,
        runningSubAgentCount: 1,
        queuedWorkflowRunCount: 1,
        queuedWorkflowAgentCount: 2,
        workflowRunIds: new Set(["run-1"]),
        workflowName: "Deep Research",
      }),
    });

    expect(
      within(row).getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent
    ).toBe("1 sub-agent active · Deep Research queued (2 agents)");
  });

  test("keeps a running workflow ahead of running sub-agents in the combined line", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      activeWorkflowRunIds: ["run-1"],
      activeWorkflowRunCount: 1,
    });

    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({
        subAgentCount: 2,
        runningSubAgentCount: 1,
        runningWorkflowRunCount: 1,
        runningWorkflowAgentCount: 3,
        workflowRunIds: new Set(["run-1"]),
        workflowName: "Deep Research",
      }),
    });

    expect(
      within(row).getByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`).textContent
    ).toBe("Deep Research running (3 agents) · 1 sub-agent active");
  });

  test("falls back to the normal status line when hidden sub-agents are all inactive", () => {
    const { row } = renderWorkspaceItem({
      hiddenSubAgentsSummary: makeHiddenSummary({ subAgentCount: 3 }),
    });
    const rowView = within(row);

    expect(rowView.queryByTestId(`workspace-hidden-subagents-${TEST_WORKSPACE_ID}`)).toBeNull();
  });

  test("keeps archiving feedback inline instead of rendering a secondary status row", () => {
    const { row } = renderWorkspaceItem({ isArchiving: true });
    const rowView = within(row);

    expect(
      rowView.getByTestId(`workspace-inline-archiving-status-${TEST_WORKSPACE_ID}`)
    ).toBeTruthy();
    expect(rowView.queryByTestId(`workspace-secondary-row-${TEST_WORKSPACE_ID}`)).toBeNull();
  });

  test("does not render a goal target pill in the workspace row", () => {
    mockWorkspaceHeartbeatsEnabled = true;
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      goal: {
        goalId: "11111111-1111-4111-8111-111111111111",
        status: "active",
        objective: "Ship goal budgets",
        budgetCents: 500,
        costCents: 125,
        turnsUsed: 4,
        turnCap: null,
        startedAtMs: Date.now(),
      },
    });

    const { row } = renderWorkspaceItem();

    expect(within(row).queryByTestId(`workspace-goal-pill-${TEST_WORKSPACE_ID}`)).toBeNull();
  });

  test("renders a heartbeat icon directly in the leading slot for seen rows when the heartbeat experiment is enabled", () => {
    mockWorkspaceHeartbeatsEnabled = true;

    const { row } = renderWorkspaceItem({
      metadata: createHeartbeatMetadata(),
    });
    const rowView = within(row);
    const heartbeatIcon = rowView.getByTestId("heartbeat-icon");

    expect(heartbeatIcon).toBeTruthy();
    expect(heartbeatIcon.parentElement?.className).toContain(
      "relative z-20 flex shrink-0 items-center justify-center self-center"
    );
    expect(heartbeatIcon.parentElement?.getAttribute("style")).toContain("width: 16px");
    expect(heartbeatIcon.parentElement?.getAttribute("style")).toContain("height: 16px");
    expect(
      rowView.queryByRole("button", { name: `Archive workspace ${TEST_WORKSPACE_TITLE}` })
    ).toBeNull();
  });

  test.each([
    [
      "sub-agent connectors to the parent and child leading status slots",
      1,
      "default" as const,
      "18px",
      "8px",
    ],
    [
      "task-group member connectors to the task-group rail",
      2.5,
      "task-group-member" as const,
      "38px",
      "1px",
    ],
  ])("anchors %s", (_name, depth, subAgentConnectorLayout, left, width) => {
    const { view } = renderWorkspaceItem({
      depth,
      subAgentConnectorLayout,
      rowRenderMeta: SUBAGENT_ROW_META,
    });

    const topSegment = view.getByTestId("subagent-connector-top-segment");
    const elbow = view.getByTestId("subagent-connector-elbow");

    expect(topSegment.getAttribute("style")).toContain(`left: ${left}`);
    expect(elbow.getAttribute("style")).toContain(`left: ${left}`);
    expect(elbow.getAttribute("style")).toContain(`width: ${width}`);
  });

  test("keeps the sub-agent elbow active during live interrupted-state fallback", () => {
    const { view } = renderWorkspaceItem({
      metadata: createMetadata({
        parentWorkspaceId: "parent",
        taskStatus: "interrupted",
      }),
      depth: 1,
      rowRenderMeta: SUBAGENT_ROW_META,
      isWorkspaceLiveActive: true,
    });

    const elbow = view.getByTestId("subagent-connector-elbow");
    expect(elbow.tagName.toLowerCase()).toBe("svg");
    expect(elbow.querySelector(".subagent-connector-elbow-active")).toBeTruthy();
  });

  test("does not render a heartbeat icon fallback when completed children indicator is shown", () => {
    mockWorkspaceHeartbeatsEnabled = true;

    const { row, metadata } = renderWorkspaceItem({
      metadata: createHeartbeatMetadata(),
      rowRenderMeta: {
        depth: 0,
        rowKind: "primary",
        connectorPosition: "single",
        connectorStartsAtParent: false,
        sharedTrunkActiveThroughRow: false,
        sharedTrunkActiveBelowRow: false,
        ancestorTrunks: [],
        hasHiddenCompletedChildren: false,
        visibleCompletedChildrenCount: 1,
      },
      completedChildrenExpanded: true,
      onToggleCompletedChildren: () => undefined,
    });
    const rowView = within(row);

    expect(rowView.queryByTestId("heartbeat-icon")).toBeNull();
    expect(
      rowView.getByTestId(`completed-children-expanded-indicator-${metadata.id}`)
    ).toBeTruthy();
    expect(
      rowView.queryByRole("button", { name: `Archive workspace ${TEST_WORKSPACE_TITLE}` })
    ).toBeNull();
  });

  test.each([
    ["the heartbeat experiment is disabled", false, createHeartbeatMetadata()],
    ["heartbeat is disabled", true, createHeartbeatMetadata({ enabled: false })],
    ["heartbeat settings are missing", true, createMetadata()],
  ])("does not render a heartbeat icon fallback when %s", (_name, experimentEnabled, metadata) => {
    mockWorkspaceHeartbeatsEnabled = experimentEnabled;

    const { row } = renderWorkspaceItem({ metadata });

    expect(within(row).queryByTestId("heartbeat-icon")).toBeNull();
  });

  test("keeps the unread idle status dot when heartbeat is enabled", () => {
    mockWorkspaceHeartbeatsEnabled = true;
    mockWorkspaceUnreadState = createWorkspaceUnreadState({ isUnread: true });

    const { row } = renderWorkspaceItem({
      metadata: createHeartbeatMetadata(),
    });

    expect(within(row).queryByTestId("heartbeat-icon")).toBeNull();
    expect(row.querySelector(".bg-surface-invert-secondary.border-surface-tertiary")).toBeTruthy();
  });

  test("keeps the secondary status row mounted through a quick create-to-stream handoff", () => {
    const metadata = createMetadata({ isInitializing: true });
    const renderItem = () => (
      <AgentListItem
        metadata={metadata}
        projectPath={metadata.projectPath}
        projectName={metadata.projectName}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
    );
    const view = render(renderItem());
    const getRow = () =>
      view.container.querySelector<HTMLElement>(
        `[data-workspace-id="${metadata.id}"][role="button"]`
      );
    const getSecondaryRow = () => view.queryByTestId(`workspace-secondary-row-${metadata.id}`);

    const assertRowStaysActive = () => {
      expect(getSecondaryRow()).toBeTruthy();
      const row = getRow();
      expect(row).toBeTruthy();
      expect(row?.querySelector(".workspace-status-dot-active")).toBeTruthy();
    };

    assertRowStaysActive();

    metadata.isInitializing = false;
    mockWorkspaceSidebarState = createWorkspaceSidebarState();
    view.rerender(renderItem());

    assertRowStaysActive();

    mockWorkspaceSidebarState = createWorkspaceSidebarState({ canInterrupt: true });
    view.rerender(renderItem());

    assertRowStaysActive();
  });

  test.each([
    {
      name: "active rows",
      sidebarState: createWorkspaceSidebarState({ canInterrupt: true }),
      expectedSelector: ".workspace-status-dot-active",
      expectedText: null,
    },
    {
      name: "starting rows",
      sidebarState: createWorkspaceSidebarState({ isStarting: true }),
      expectedSelector: ".workspace-status-dot-active",
      expectedText: null,
    },
    {
      name: "question rows",
      sidebarState: createWorkspaceSidebarState({ awaitingUserQuestion: true }),
      expectedSelector: ".bg-border-pending.border-surface-sky",
      expectedText: "Xum has a few questions",
    },
    {
      name: "error rows",
      sidebarState: createWorkspaceSidebarState({ lastAbortReason: createSystemAbortReason() }),
      expectedSelector: ".bg-content-destructive.border-surface-destructive",
      expectedText: null,
    },
  ])(
    "leaves $name unchanged when heartbeat is enabled",
    ({ sidebarState, expectedSelector, expectedText }) => {
      mockWorkspaceHeartbeatsEnabled = true;
      mockWorkspaceSidebarState = sidebarState;

      const { row } = renderWorkspaceItem({
        metadata: createMetadata({
          heartbeat: { enabled: true, intervalMs: HEARTBEAT_INTERVAL_MS },
        }),
      });

      expect(within(row).queryByTestId("heartbeat-icon")).toBeNull();
      expect(row.querySelector(expectedSelector)).toBeTruthy();
      if (expectedText) {
        expect(within(row).getByText(expectedText)).toBeTruthy();
      }
    }
  );
});
