import "../dom";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { shouldRunIntegrationTests } from "../../testUtils";
import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Memory Intuition settings", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("parent toggle hides recall controls and its internal agent without resetting the preference", async () => {
    const app = await createAppHarness({ branchPrefix: "intuition-settings", aiMode: "none" });
    try {
      const canvas = within(app.view.container);
      fireEvent.click(await canvas.findByTestId("settings-button"));
      const openSection = async (name: string) => {
        const buttons = await canvas.findAllByRole("button", { name });
        fireEvent.click(buttons[0]);
      };
      await openSection("Experiments");
      const memoryToggle = await canvas.findByLabelText("Toggle Agent Memory");
      if (memoryToggle.getAttribute("aria-checked") === "true") fireEvent.click(memoryToggle);
      await waitFor(() => expect(canvas.queryByLabelText("Toggle Memory Intuition")).toBeNull());

      fireEvent.click(memoryToggle);
      const intuitionToggle = await canvas.findByLabelText("Toggle Memory Intuition");
      if (intuitionToggle.getAttribute("aria-checked") !== "true") fireEvent.click(intuitionToggle);
      await waitFor(() => expect(intuitionToggle.getAttribute("aria-checked")).toBe("true"));

      await openSection("Agents");
      await canvas.findByText("Intuition");
      await openSection("Experiments");
      fireEvent.click(await canvas.findByLabelText("Toggle Agent Memory"));
      await waitFor(() => expect(canvas.queryByLabelText("Toggle Memory Intuition")).toBeNull());
      await openSection("Agents");
      await canvas.findByText("Name Workspace");
      expect(canvas.queryByText("Intuition")).toBeNull();

      await openSection("Experiments");
      fireEvent.click(await canvas.findByLabelText("Toggle Agent Memory"));
      const restored = await canvas.findByLabelText("Toggle Memory Intuition");
      expect(restored.getAttribute("aria-checked")).toBe("true");
    } finally {
      await app.dispose();
    }
  }, 120_000);
});
