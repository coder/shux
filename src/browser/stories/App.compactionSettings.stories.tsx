import { expect, fn, userEvent, waitFor, within } from "@storybook/test";
import { wrapAsyncIterator } from "@orpc/shared";
import type { APIClient } from "@/browser/contexts/API";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { expandLeftSidebar } from "./helpers/uiState";
import { setupSettingsStory } from "@/browser/features/Settings/Sections/settingsStoryUtils";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";

export default { ...appMeta, title: "App/CompactionSettings" };

const setOverride = fn<APIClient["experiments"]["setOverride"]>(() => Promise.resolve());
const getOverrides = fn<APIClient["experiments"]["getOverrides"]>(() => Promise.resolve({}));

function setupCompactionSettings(mode: "legacy" | "defaults" | "conflict" = "legacy") {
  expandLeftSidebar();
  setOverride.mockClear();
  getOverrides.mockClear();
  const client = setupSettingsStory({
    experiments: {
      ...(mode === "defaults"
        ? {}
        : {
            [EXPERIMENT_IDS.CONTINUOUS_COMPACTION]: mode === "legacy",
            [EXPERIMENT_IDS.TOKEN_BUDGET]: true,
          }),
      [EXPERIMENT_IDS.PROGRAMMATIC_TOOL_CALLING]: mode === "conflict",
      [EXPERIMENT_IDS.RLM]: mode === "conflict",
    },
  });
  client.experiments = {
    setOverride,
    getOverrides,
    onDesignChange: () =>
      Promise.resolve(
        wrapAsyncIterator(
          (async function* () {
            yield await Promise.resolve({ enabled: false, revision: 0 });
          })(),
          {}
        )
      ),
  };
  return client;
}

async function openCompactionSettings(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByTestId("settings-button", {}, { timeout: 10000 }));
  const trigger = await canvas.findByRole("combobox", { name: "Compaction strategy" });
  trigger.scrollIntoView({ block: "center" });
  // Initial local-override uploads belong to provider reconciliation, not a dropdown choice.
  await waitFor(async () => expect(getOverrides).toHaveBeenCalled());
  setOverride.mockClear();
  return trigger;
}

async function expectPersistedStrategy(continuous: boolean, budget: boolean) {
  await waitFor(async () => {
    await expect(
      readPersistedState(getExperimentKey(EXPERIMENT_IDS.CONTINUOUS_COMPACTION), undefined)
    ).toBe(continuous);
    await expect(readPersistedState(getExperimentKey(EXPERIMENT_IDS.TOKEN_BUDGET), undefined)).toBe(
      budget
    );
  });
}

async function expectStrategyWrites(continuous: boolean, budget: boolean) {
  await waitFor(async () => expect(setOverride).toHaveBeenCalledTimes(2));
  await expect(setOverride).toHaveBeenCalledWith({
    experimentId: EXPERIMENT_IDS.CONTINUOUS_COMPACTION,
    enabled: continuous,
  });
  await expect(setOverride).toHaveBeenCalledWith({
    experimentId: EXPERIMENT_IDS.TOKEN_BUDGET,
    enabled: budget,
  });
}

async function dismissWithoutChoosing(trigger: HTMLElement) {
  await userEvent.click(trigger);
  await userEvent.keyboard("{Escape}");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(setOverride).not.toHaveBeenCalled();
}

async function selectStrategy(trigger: HTMLElement, name: string) {
  setOverride.mockClear();
  await userEvent.click(trigger);
  const body = within(trigger.ownerDocument.body);
  await userEvent.click(await body.findByRole("option", { name }));
  await expect(trigger).toHaveTextContent(name);
}

async function exerciseCompactionSettings(canvasElement: HTMLElement) {
  const trigger = await openCompactionSettings(canvasElement);
  await expect(trigger).toHaveTextContent("Continuous");
  await expectPersistedStrategy(true, true);
  await dismissWithoutChoosing(trigger);

  // Real Radix must commit an explicit choice even when legacy flags display that same value.
  await selectStrategy(trigger, "Continuous");
  await expectPersistedStrategy(true, false);
  await expectStrategyWrites(true, false);
  await selectStrategy(trigger, "Token Budget");
  await expectPersistedStrategy(false, true);
  await expectStrategyWrites(false, true);
  await selectStrategy(trigger, "Summarize");
  await expectPersistedStrategy(false, false);
  await expectStrategyWrites(false, false);

  // Leave the menu open to capture all three choices at desktop and phone widths.
  await userEvent.click(trigger);
  const body = within(trigger.ownerDocument.body);
  const listbox = await body.findByRole("listbox");
  await expect(within(listbox).getAllByRole("option")).toHaveLength(3);
  for (const name of ["Summarize", "Continuous", "Token Budget"]) {
    await expect(within(listbox).getByRole("option", { name })).toBeVisible();
  }
  // The Storybook runner ignores viewport globals; only assert phone bounds at narrow widths.
  if (window.innerWidth < 768) {
    await expect(trigger.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(listbox.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
    await expect(listbox.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  }
}

export const Desktop: AppStory = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["desktop"] } } },
  render: () => <AppWithMocks setup={() => setupCompactionSettings()} />,
  play: async ({ canvasElement }) => exerciseCompactionSettings(canvasElement),
};

export const Phone: AppStory = {
  ...Desktop,
  globals: { viewport: { value: "phone", isRotated: false } },
  parameters: {
    viewport: {
      options: {
        phone: {
          name: "Phone",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
      },
    },
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  play: async ({ canvasElement }) => exerciseCompactionSettings(canvasElement),
};

export const ExplicitSummarize: AppStory = {
  render: () => <AppWithMocks setup={() => setupCompactionSettings("defaults")} />,
  play: async ({ canvasElement }) => {
    const trigger = await openCompactionSettings(canvasElement);
    await expect(trigger).toHaveTextContent("Summarize");
    for (const id of [EXPERIMENT_IDS.CONTINUOUS_COMPACTION, EXPERIMENT_IDS.TOKEN_BUDGET]) {
      await expect(readPersistedState(getExperimentKey(id), undefined)).toBeUndefined();
    }
    await dismissWithoutChoosing(trigger);
    // Keyboard activation must commit the current default just like a pointer selection.
    await userEvent.click(trigger);
    const option = within(trigger.ownerDocument.body).getByRole("option", { name: "Summarize" });
    option.focus();
    await userEvent.keyboard("{Enter}");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expectPersistedStrategy(false, false);
    await expectStrategyWrites(false, false);
  },
};

export const TokenBudgetConflict: AppStory = {
  render: () => <AppWithMocks setup={() => setupCompactionSettings("conflict")} />,
  play: async ({ canvasElement }) => {
    const trigger = await openCompactionSettings(canvasElement);
    const canvas = within(canvasElement);
    await expect(trigger).toHaveTextContent("Token Budget");
    const warning = canvas.getByRole("status");
    await expect(warning).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-describedby", warning.id);
    await selectStrategy(trigger, "Continuous");
    await expect(canvas.queryByRole("status")).toBeNull();
    await selectStrategy(trigger, "Token Budget");
    await expectPersistedStrategy(false, true);
    await expect(canvas.getByRole("status")).toBeVisible();
  },
};
