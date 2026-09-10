import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import * as ProjectContextModule from "@/browser/contexts/ProjectContext";
import * as SettingsContextModule from "@/browser/contexts/SettingsContext";
import type { ProjectConfig } from "@/common/types/project";
import type { Result } from "@/common/types/result";
import { InstructionsSection } from "./InstructionsSection";

const PROJECT_PATH = "/projects/demo-project";

const resolveVoidResult = (): Promise<Result<void>> =>
  Promise.resolve({ success: true, data: undefined });

function mockProjectContext(
  userProjects: Map<string, ProjectConfig>,
  updateCustomInstructions: ProjectContextModule.ProjectContext["updateCustomInstructions"]
) {
  spyOn(ProjectContextModule, "useProjectContext").mockImplementation(
    () =>
      ({
        userProjects,
        updateCustomInstructions,
      }) as unknown as ProjectContextModule.ProjectContext
  );
}

function mockSettingsContext(instructionsProjectPath: string | null = null) {
  // Stateful, stable-identity mock mirroring production: the setter really
  // clears the hint and keeps its identity across renders. A fresh no-op
  // setter per render re-fires the hint effect forever, masking ordering
  // races between the hint and the default selection.
  let hint = instructionsProjectPath;
  const setInstructionsProjectPath = (value: string | null) => {
    hint = value;
  };
  spyOn(SettingsContextModule, "useSettings").mockImplementation(
    () =>
      ({
        instructionsProjectPath: hint,
        setInstructionsProjectPath,
      }) as unknown as ReturnType<typeof SettingsContextModule.useSettings>
  );
}

// happy-dom does not deliver React's synthetic onChange for controlled fields,
// so invoke the element's React onChange prop directly (same workaround as
// SshPromptDialog.test.tsx).
function typeIntoTextarea(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
  const reactPropsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps"));
  if (!reactPropsKey) {
    throw new Error("Expected textarea to expose React props");
  }
  const reactProps = (textarea as unknown as Record<string, unknown>)[reactPropsKey] as {
    onChange?: (event: { target: { value: string } }) => void;
  };
  if (!reactProps.onChange) {
    throw new Error("Expected textarea to expose onChange handler");
  }
  act(() => {
    reactProps.onChange!({ target: { value } });
  });
}

describe("InstructionsSection", () => {
  let cleanupDom: () => void;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom();
  });

  test("saves the edited draft for the selected project", async () => {
    const updateCustomInstructions = mock(
      (_projectPath: string, _customInstructions: string | null) => resolveVoidResult()
    );
    mockProjectContext(new Map([[PROJECT_PATH, { workspaces: [] }]]), updateCustomInstructions);
    mockSettingsContext();

    const view = render(<InstructionsSection />);

    const textarea = view.getByRole("textbox", { name: "Project custom instructions" });
    const save = view.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    typeIntoTextarea(textarea as HTMLTextAreaElement, "Never commit directly to main.");
    expect((save as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(save);

    await waitFor(() => {
      expect(updateCustomInstructions).toHaveBeenCalledWith(
        PROJECT_PATH,
        "Never commit directly to main."
      );
    });
  });

  test("Cmd/Ctrl+Enter in the textarea saves, but only when dirty", async () => {
    const updateCustomInstructions = mock(
      (_projectPath: string, _customInstructions: string | null) => resolveVoidResult()
    );
    mockProjectContext(new Map([[PROJECT_PATH, { workspaces: [] }]]), updateCustomInstructions);
    mockSettingsContext();

    const view = render(<InstructionsSection />);
    const textarea = view.getByRole("textbox", { name: "Project custom instructions" });

    // happy-dom does not deliver React's synthetic keyDown either, so invoke
    // the element's React onKeyDown prop directly (same workaround as
    // typeIntoTextarea above).
    const pressModEnter = (modifier: "metaKey" | "ctrlKey") => {
      const reactPropsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps"));
      if (!reactPropsKey) throw new Error("Expected textarea to expose React props");
      const reactProps = (textarea as unknown as Record<string, unknown>)[reactPropsKey] as {
        onKeyDown?: (event: {
          key: string;
          metaKey: boolean;
          ctrlKey: boolean;
          preventDefault: () => void;
        }) => void;
      };
      if (!reactProps.onKeyDown) throw new Error("Expected textarea to expose onKeyDown handler");
      act(() => {
        reactProps.onKeyDown!({
          key: "Enter",
          metaKey: modifier === "metaKey",
          ctrlKey: modifier === "ctrlKey",
          preventDefault: () => undefined,
        });
      });
    };

    // Not dirty: the shortcut must not save.
    pressModEnter("metaKey");
    expect(updateCustomInstructions).not.toHaveBeenCalled();

    typeIntoTextarea(textarea as HTMLTextAreaElement, "Shortcut-saved guidance.");
    pressModEnter("ctrlKey");

    await waitFor(() => {
      expect(updateCustomInstructions).toHaveBeenCalledWith(
        PROJECT_PATH,
        "Shortcut-saved guidance."
      );
    });
  });

  test("clearing saved instructions saves null so config stays minimal", async () => {
    const updateCustomInstructions = mock(
      (_projectPath: string, _customInstructions: string | null) => resolveVoidResult()
    );
    mockProjectContext(
      new Map([
        [PROJECT_PATH, { workspaces: [], customInstructions: "Existing project guidance." }],
      ]),
      updateCustomInstructions
    );
    mockSettingsContext();

    const view = render(<InstructionsSection />);

    const textarea = view.getByRole("textbox", { name: "Project custom instructions" });
    expect((textarea as HTMLTextAreaElement).value).toBe("Existing project guidance.");

    typeIntoTextarea(textarea as HTMLTextAreaElement, "   ");
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateCustomInstructions).toHaveBeenCalledWith(PROJECT_PATH, null);
    });
  });

  test("pre-selects the project from the one-shot settings hint", () => {
    const otherPath = "/projects/other-project";
    mockProjectContext(
      new Map([
        [PROJECT_PATH, { workspaces: [] }],
        [otherPath, { workspaces: [], customInstructions: "Other project guidance." }],
      ]),
      () => resolveVoidResult()
    );
    mockSettingsContext(otherPath);

    const view = render(<InstructionsSection />);

    const textarea = view.getByRole("textbox", { name: "Project custom instructions" });
    expect((textarea as HTMLTextAreaElement).value).toBe("Other project guidance.");
  });
});
