import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { AgentProvider, type AgentContextValue } from "@/browser/contexts/AgentContext";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { AgentModePicker } from "../AgentModePicker/AgentModePicker";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";

const BUILT_INS: AgentDefinitionDescriptor[] = [
  {
    id: "exec",
    scope: "built-in",
    name: "Exec",
    uiSelectable: true,
    subagentRunnable: false,
  },
  {
    id: "plan",
    scope: "built-in",
    name: "Plan",
    uiSelectable: true,
    subagentRunnable: false,
    base: "plan",
  },
];

const HIDDEN_AGENT: AgentDefinitionDescriptor = {
  id: "explore",
  scope: "built-in",
  name: "Explore",
  uiSelectable: false,
  subagentRunnable: true,
  base: "exec",
};
const CUSTOM_AGENT: AgentDefinitionDescriptor = {
  id: "review",
  scope: "project",
  name: "Review",
  description: "Review changes",
  uiSelectable: true,
  subagentRunnable: false,
};

const noop = () => {
  // intentional noop for tests
};
const defaultContextProps = {
  currentAgent: undefined,
  isAgentSelectionLocked: false,
  disableWorkspaceAgents: false,
  setDisableWorkspaceAgents: noop,
};

let cleanupDom: (() => void) | null = null;

describe("AgentModePicker", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  function Harness(props: {
    initialAgentId?: string;
    agents?: AgentDefinitionDescriptor[];
    loaded?: boolean;
    currentAgent?: AgentDefinitionDescriptor;
    locked?: boolean;
    showAgentId?: boolean;
  }) {
    const [agentId, setAgentId] = React.useState(props.initialAgentId ?? "exec");
    const contextValue: AgentContextValue & { isAgentSelectionLocked?: boolean } = {
      agentId,
      setAgentId,
      agents: props.agents ?? [...BUILT_INS, CUSTOM_AGENT],
      loaded: props.loaded ?? true,
      loadFailed: false,
      refresh: () => Promise.resolve(),
      refreshing: false,
      ...defaultContextProps,
      currentAgent: props.currentAgent,
      isAgentSelectionLocked: props.locked ?? false,
    };

    return (
      <AgentProvider value={contextValue}>
        <TooltipProvider>
          {props.showAgentId ? <div data-testid="agentId">{agentId}</div> : null}
          <AgentModePicker />
        </TooltipProvider>
      </AgentProvider>
    );
  }

  function renderPicker(props: Parameters<typeof Harness>[0] = {}) {
    return render(<Harness {...props} />);
  }

  test("renders a stable label for explore before agent definitions load", () => {
    const { getByText } = renderPicker({ initialAgentId: "explore", agents: [], loaded: false });

    // Regression: avoid "explore" -> "Explore" flicker while agents load.
    expect(getByText("Explore")).toBeTruthy();
  });

  test("locks the picker when workspace agent selection is locked", () => {
    const { getByLabelText, queryAllByTestId } = renderPicker({
      agents: [...BUILT_INS, HIDDEN_AGENT, CUSTOM_AGENT],
      currentAgent: BUILT_INS[0],
      locked: true,
      showAgentId: true,
    });

    const triggerButton = getByLabelText("Select agent") as HTMLButtonElement;
    expect(triggerButton.textContent).toContain("Exec");
    expect(triggerButton.disabled).toBe(true);

    fireEvent.click(triggerButton);
    expect(queryAllByTestId("agent-option").length).toBe(0);
  });

  test("uiSelectable false without lock flag does not disable the picker", async () => {
    const { getByLabelText, queryAllByTestId } = renderPicker({
      initialAgentId: "explore",
      agents: [...BUILT_INS, HIDDEN_AGENT, CUSTOM_AGENT],
      currentAgent: HIDDEN_AGENT,
      showAgentId: true,
    });

    const triggerButton = getByLabelText("Select agent") as HTMLButtonElement;
    expect(triggerButton.textContent).toContain("Explore");
    expect(triggerButton.disabled).toBe(false);

    fireEvent.click(triggerButton);

    await waitFor(() => {
      expect(queryAllByTestId("agent-option").length).toBeGreaterThan(0);
    });
  });

  test("selects a custom agent from the dropdown", async () => {
    const { getByTestId, getByText, getByLabelText } = renderPicker({ showAgentId: true });

    fireEvent.click(getByLabelText("Select agent"));

    await waitFor(() => {
      expect(getByText("Review")).toBeTruthy();
    });

    fireEvent.click(getByText("Review"));

    await waitFor(() => {
      expect(getByTestId("agentId").textContent).toBe("review");
    });
  });

  test("numbered guest shortcuts do not select a host agent", async () => {
    const view = renderPicker({ showAgentId: true });
    fireEvent.click(view.getByLabelText("Select agent"));
    await waitFor(() => expect(view.getAllByTestId("agent-option").length).toBe(3));
    const viewport = document.createElement("div");
    viewport.setAttribute("data-desktop-viewport", "");
    const canvas = document.createElement("canvas");
    viewport.appendChild(canvas);
    view.container.appendChild(viewport);
    const event = new window.KeyboardEvent("keydown", {
      key: "3",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(canvas, event);
    expect(event.defaultPrevented).toBe(false);
    expect(view.getByTestId("agentId").textContent).toBe("exec");
    expect(view.getAllByTestId("agent-option").length).toBe(3);

    fireEvent.keyDown(document.body, { key: "3", ctrlKey: true });
    expect(view.getByTestId("agentId").textContent).toBe("review");
  });

  test("does not render auto agent affordances", async () => {
    const { getByLabelText, queryByLabelText, queryByText } = renderPicker();
    const autoSelectLabel = ["Auto-select", "agent"].join(" ");

    fireEvent.click(getByLabelText("Select agent"));

    await waitFor(() => {
      expect(queryByLabelText(autoSelectLabel)).toBeNull();
      expect(queryByText("Xum chooses the best agent")).toBeNull();
    });
  });
});
