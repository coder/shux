/**
 * Integration coverage for the chat-input thinking selector: thinking options,
 * route-aware Pro visibility, and the global OpenAI fast-mode indicator.
 */

import "../dom";
import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CUSTOM_EVENTS } from "@/common/constants/events";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { getModelKey } from "@/common/constants/storage";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";

import { shouldRunIntegrationTests } from "../../testUtils";
import { setupProviders } from "../../ipc/setup";
import { createAppHarness } from "../harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

const SOL_MODEL = KNOWN_MODELS.GPT.id;
// Pro mode is family-wide across GPT-5.6 (incl. Luna), so the hidden case
// uses a pre-5.6 OpenAI model that can still exercise the fast-mode row.
const NON_PRO_MODEL = KNOWN_MODELS.GPT_PRO.id;

async function openModelSelector(container: HTMLElement): Promise<HTMLInputElement> {
  window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_MODEL_SELECTOR));

  return await waitFor(() => {
    const input = container.querySelector<HTMLInputElement>(
      'input[placeholder="Search [provider:model-name]"]'
    );
    if (!input) {
      throw new Error("Model selector input not found");
    }
    return input;
  });
}

async function selectModel(
  container: HTMLElement,
  workspaceId: string,
  model: string
): Promise<void> {
  const input = await openModelSelector(container);
  const user = userEvent.setup({ document: container.ownerDocument });
  await user.clear(input);
  await user.type(input, model);

  const modelName = model.split(":")[1] ?? model;
  const option = await waitFor(() =>
    within(container).getByText(formatModelDisplayName(modelName))
  );
  fireEvent.click(option);

  await waitFor(() => {
    const persisted = readPersistedState(getModelKey(workspaceId), "");
    if (persisted !== model) {
      throw new Error(`Expected model ${model} but got ${persisted}`);
    }
  });
}

async function openThinkingSelector(container: HTMLElement): Promise<HTMLElement> {
  const existing = container.querySelector<HTMLElement>('[data-component="ThinkingSelectorMenu"]');
  if (existing) return existing;

  const trigger = await waitFor(() => {
    const match = container.querySelector<HTMLButtonElement>("[data-thinking-selector-trigger]");
    if (!match) throw new Error("Thinking selector trigger not found");
    return match;
  });
  fireEvent.click(trigger);

  return await waitFor(() => {
    const menu = container.querySelector<HTMLElement>('[data-component="ThinkingSelectorMenu"]');
    if (!menu) throw new Error("Thinking selector menu not found");
    return menu;
  });
}

async function expectPressed(toggle: HTMLElement, pressed: boolean): Promise<void> {
  await waitFor(() => {
    if (toggle.getAttribute("aria-pressed") !== String(pressed)) {
      throw new Error(
        `Expected ${toggle.dataset.component} aria-pressed=${pressed}, got ${toggle.getAttribute("aria-pressed")}`
      );
    }
  });
}

describeIntegration("Thinking selector", () => {
  test("selects effort, gates Pro, and exposes fast mode with a closed-state indicator", async () => {
    const harness = await createAppHarness({
      branchPrefix: "thinking-selector",
      beforeRenderEnvironment: async (env) => {
        await setupProviders(env, { xai: { apiKey: "dummy" } });
      },
    });

    try {
      const { container } = harness.view;
      await selectModel(container, harness.workspaceId, SOL_MODEL);

      let menu = await openThinkingSelector(container);
      let escapeReachedWindow = false;
      const handleWindowKeyDown = () => {
        escapeReachedWindow = true;
      };
      window.addEventListener("keydown", handleWindowKeyDown);
      fireEvent.keyDown(menu, { key: "Escape" });
      window.removeEventListener("keydown", handleWindowKeyDown);
      if (escapeReachedWindow) {
        throw new Error("Selector Escape reached the native window listener");
      }
      if (container.querySelector('[data-component="ThinkingSelectorMenu"]')) {
        throw new Error("Thinking selector did not close on Escape");
      }

      menu = await openThinkingSelector(container);
      const highOption = within(menu).getByRole("option", { name: "High" });
      fireEvent.click(highOption);
      await waitFor(() => {
        const label = container.querySelector("[data-thinking-label]")?.textContent?.trim();
        if (label !== "HIGH") throw new Error(`Expected HIGH thinking label, got ${label}`);
        if (!container.querySelector('[data-component="ThinkingSelectorMenu"]')) {
          throw new Error("Thinking selector closed after choosing an effort");
        }
      });

      const proToggle = within(menu).getByRole("button", { name: /Pro mode/i });
      const fastToggle = within(menu).getByRole("button", { name: /Fast mode/i });
      await expectPressed(proToggle, false);
      await expectPressed(fastToggle, false);

      fireEvent.click(proToggle);
      await expectPressed(proToggle, true);
      if (!container.querySelector('[data-component="ThinkingSelectorMenu"]')) {
        throw new Error("Thinking selector closed after toggling Pro mode");
      }
      if (!container.querySelector("[data-thinking-pro-status]")) {
        throw new Error("Open selector did not immediately show Pro status");
      }

      fireEvent.click(fastToggle);
      await expectPressed(fastToggle, true);
      if (!container.querySelector('[data-component="ThinkingSelectorMenu"]')) {
        throw new Error("Thinking selector closed after toggling Fast mode");
      }
      if (!container.querySelector("[data-fast-mode-indicator]")) {
        throw new Error("Open selector did not immediately show Fast status");
      }
      fireEvent.click(container.querySelector("[data-thinking-selector-trigger]")!);
      await waitFor(() => {
        if (!container.querySelector("[data-thinking-pro-status]")) {
          throw new Error("Closed-state Pro status was not rendered");
        }
        if (!container.querySelector("[data-fast-mode-indicator]")) {
          throw new Error("Fast-mode lightning indicator was not rendered");
        }
      });

      // GPT-5.5 Pro does not support reasoning.mode=pro, but fast mode remains
      // available because it is a direct OpenAI service-tier option.
      await selectModel(container, harness.workspaceId, NON_PRO_MODEL);
      menu = await openThinkingSelector(container);
      if (menu.querySelector('[data-component="ProModeToggle"]')) {
        throw new Error("Pro toggle should not render for a non-Pro-capable model");
      }
      if (!menu.querySelector('[data-component="FastModeToggle"]')) {
        throw new Error("Fast mode should remain available for direct OpenAI models");
      }
      fireEvent.click(container.querySelector("[data-thinking-selector-trigger]")!);

      // Workspace-scoped Pro state survives model switches; OpenAI fast mode remains
      // in its provider config and becomes active again when returning to OpenAI.
      await selectModel(container, harness.workspaceId, SOL_MODEL);
      menu = await openThinkingSelector(container);
      await expectPressed(within(menu).getByRole("button", { name: /Pro mode/i }), true);
      await expectPressed(within(menu).getByRole("button", { name: /Fast mode/i }), true);
      fireEvent.click(container.querySelector("[data-thinking-selector-trigger]")!);

      // Grok uses the same thinking selector with its native low/medium/high/xhigh
      // ladder, while Fast mode writes xAI's priority tier instead of OpenAI's.
      await selectModel(container, harness.workspaceId, KNOWN_MODELS.GROK_46.id);
      menu = await openThinkingSelector(container);
      if (menu.querySelector('[data-component="ProModeToggle"]')) {
        throw new Error("Pro toggle should not render for Grok");
      }
      if (within(menu).queryByRole("option", { name: "Off" })) {
        throw new Error("Grok should not offer thinking Off");
      }
      within(menu).getByRole("option", { name: "Medium" });
      within(menu).getByRole("option", { name: "High" });
      within(menu).getByRole("option", { name: "Extra High" });

      const grokFastToggle = within(menu).getByRole("button", { name: /Fast mode/i });
      await expectPressed(grokFastToggle, false);
      fireEvent.click(grokFastToggle);
      await expectPressed(grokFastToggle, true);
      if (!container.querySelector("[data-fast-mode-indicator]")) {
        throw new Error("Grok fast-mode indicator was not rendered");
      }
    } finally {
      await harness.dispose();
    }
  }, 90_000);
});
