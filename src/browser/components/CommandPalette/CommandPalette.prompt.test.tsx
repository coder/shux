import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../tests/ui/dom";
import { APIProvider } from "@/browser/contexts/API";
import {
  CommandRegistryProvider,
  useCommandRegistry,
  type CommandAction,
} from "@/browser/contexts/CommandRegistryContext";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { CommandPalette } from "./CommandPalette";

function PaletteHarness(props: { action: CommandAction }) {
  const registry = useCommandRegistry();

  return (
    <>
      <button type="button" onClick={() => registry.open(">")}>
        Open palette
      </button>
      <RegisterAction action={props.action} />
      <CommandPalette />
    </>
  );
}

function RegisterAction(props: { action: CommandAction }) {
  const { registerSource } = useCommandRegistry();

  React.useEffect(() => registerSource(() => [props.action]), [props.action, registerSource]);

  return null;
}

function renderPalette(action: CommandAction) {
  return render(
    <APIProvider client={createMockORPCClient()}>
      <CommandRegistryProvider>
        <PaletteHarness action={action} />
      </CommandRegistryProvider>
    </APIProvider>
  );
}

describe("CommandPalette inline goal prompts", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("guest Escape leaves the host palette open", async () => {
    const view = renderPalette({
      id: "test-action",
      title: "Test action",
      section: "Tests",
      run: () => undefined,
    });
    fireEvent.click(view.getByRole("button", { name: "Open palette" }));
    const input = await view.findByRole("combobox");
    const viewport = document.createElement("div");
    viewport.setAttribute("data-desktop-viewport", "");
    const canvas = document.createElement("canvas");
    viewport.appendChild(canvas);
    view.container.appendChild(viewport);
    const event = new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(canvas, event);
    expect(event.defaultPrevented).toBe(false);
    expect(view.getByRole("combobox")).toBe(input);

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("combobox")).toBeNull());
  });

  test("Goal: Set objective traps focus and restores it on dismissal", async () => {
    const action: CommandAction = {
      id: "goal:set-objective",
      title: "Goal: Set objective",
      section: "Goals",
      run: () => undefined,
      prompt: {
        fields: [
          {
            type: "text",
            name: "objective",
            label: "Goal objective",
            placeholder: "Describe the goal…",
          },
        ],
        onSubmit: mock(),
      },
    };
    const view = renderPalette(action);

    const opener = view.getByRole("button", { name: "Open palette" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await view.findByText("Goal: Set objective"));

    const objectiveInput = await view.findByRole("combobox", { name: "Goal objective" });
    await waitFor(() => expect(document.activeElement).toBe(objectiveInput));

    fireEvent.keyDown(objectiveInput, { key: "Tab" });
    fireEvent.keyDown(objectiveInput, { key: "Tab" });
    fireEvent.keyDown(objectiveInput, { key: "Tab", shiftKey: true });
    expect(objectiveInput.closest('[cmdk-root=""]')?.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(objectiveInput, { key: "Escape" });
    await waitFor(() => expect(view.queryByText("Goal: Set objective")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  test("Goal: Mark complete traps focus and restores it on dismissal", async () => {
    const action: CommandAction = {
      id: "goal:mark-complete",
      title: "Goal: Mark complete",
      section: "Goals",
      run: () => undefined,
      prompt: {
        fields: [
          {
            type: "text",
            name: "summary",
            label: "Completion summary",
            placeholder: "Summarize the completed goal…",
          },
        ],
        onSubmit: mock(),
      },
    };
    const view = renderPalette(action);

    const opener = view.getByRole("button", { name: "Open palette" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await view.findByText("Goal: Mark complete"));

    const summaryInput = await view.findByRole("combobox", { name: "Completion summary" });
    await waitFor(() => expect(document.activeElement).toBe(summaryInput));

    fireEvent.keyDown(summaryInput, { key: "Tab" });
    fireEvent.keyDown(summaryInput, { key: "Tab", shiftKey: true });
    expect(summaryInput.closest('[cmdk-root=""]')?.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(summaryInput, { key: "Escape" });
    await waitFor(() => expect(view.queryByText("Goal: Mark complete")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});
