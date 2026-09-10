import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { within, userEvent, waitFor } from "@storybook/test";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getModelKey } from "@/common/constants/storage";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

const meta = {
  ...appMeta,
  title: "App/Chat/Components/ModelSelector",
};

export default meta;

const DEFAULT_AGENT_LABEL =
  WORKSPACE_DEFAULTS.agentId.slice(0, 1).toUpperCase() + WORKSPACE_DEFAULTS.agentId.slice(1);

/**
 * Model selector pretty display with mux-gateway enabled.
 *
 * Regression test: when gateway is enabled, routing happens in the backend,
 * but the UI should still display the canonical provider:model form
 * (e.g. GPT-4o, not "Openai/gpt 4o").
 */
export const ModelSelectorPrettyWithGateway: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-gateway-model";
        const baseModel = "openai:gpt-4o";

        // Ensure the gateway indicator is active (so the regression would reproduce).
        updatePersistedState(getModelKey(workspaceId), baseModel);

        return setupSimpleChatStory({
          workspaceId,
          messages: [],
          routePriority: ["mux-gateway", "direct"],
          providersConfig: {
            "mux-gateway": {
              apiKeySet: false,
              isEnabled: true,
              couponCodeSet: true,
              isConfigured: true,
              gatewayModels: [baseModel],
            },
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);

    // Wait for chat input to mount.
    await canvas.findAllByText(DEFAULT_AGENT_LABEL, {}, { timeout: 15000 });

    // With gateway enabled, we should still display the *pretty* model name.
    // CI can take longer than the default waitFor timeout while workspace/model
    // state hydrates, so wait explicitly instead of triggering a flaky retry.
    await waitFor(
      () => {
        canvas.getByText("GPT-4o");
      },
      { interval: 50, timeout: 10000 }
    );

    // The buggy rendering (mux-gateway:openai/gpt-4o) shows up as "Openai/gpt 4o".
    const ugly = canvas.queryByText("Openai/gpt 4o");
    if (ugly) {
      throw new Error(`Unexpected gateway-formatted model label: ${ugly.textContent ?? "(empty)"}`);
    }

    // Sanity check that the gateway indicator exists (moved to the titlebar).
    const gatewayIndicator = await waitFor(
      () => {
        const el = canvasElement.querySelector('[aria-label="Xum Gateway routing"]');
        if (!el) throw new Error("Gateway indicator not found");
        return el;
      },
      { interval: 50, timeout: 15000 }
    );

    // Hover to prove the gateway tooltip is wired up (and keep it visible for snapshot).
    await userEvent.hover(gatewayIndicator);
    await waitFor(
      () => {
        const tooltip = document.querySelector('[role="tooltip"]');
        if (!tooltip) throw new Error("Tooltip not visible");
        if (!tooltip.textContent?.includes("Xum Gateway")) {
          throw new Error("Gateway tooltip not visible");
        }
      },
      { interval: 50, timeout: 5000 }
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          "Verifies the bottom-left model selector stays pretty (e.g. GPT-4o) even when mux-gateway routing is enabled.",
      },
    },
  },
};

/**
 * Model selector dropdown open, showing icon alignment.
 * The gateway toggle and default star icons should appear side-by-side without gaps.
 */
export const ModelSelectorDropdownOpen: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-model-dropdown";
        const baseModel = "openai:gpt-4o";

        // Set the selected model for this workspace
        updatePersistedState(getModelKey(workspaceId), baseModel);

        return setupSimpleChatStory({
          workspaceId,
          messages: [],
          providersConfig: {
            openai: { apiKeySet: true, isEnabled: true, couponCodeSet: false, isConfigured: true },
            anthropic: {
              apiKeySet: true,
              isEnabled: true,
              couponCodeSet: false,
              isConfigured: true,
            },
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);

    // Wait for chat input to mount
    await canvas.findAllByText(DEFAULT_AGENT_LABEL, {}, { timeout: 15000 });

    // Wait for model selector to be clickable (shows pretty name "GPT-4o")
    const modelSelector = await waitFor(() => {
      const el = canvas.getByText("GPT-4o");
      if (!el) throw new Error("Model selector not found");
      return el;
    });

    // Click to open the selector (enters editing mode, shows dropdown)
    await userEvent.click(modelSelector);

    // Wait for the dropdown to appear. The dropdown is rendered inline (not via Radix Portal),
    // so the search input is a reliable signal that it opened.
    await canvas.findByPlaceholderText(/Search \[provider:model-name\]/i);

    // Double RAF for visual stability after dropdown renders
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  },
  parameters: {
    docs: {
      description: {
        story:
          "Model selector dropdown open, showing gateway toggle and default star icons properly aligned without gaps.",
      },
    },
  },
};
