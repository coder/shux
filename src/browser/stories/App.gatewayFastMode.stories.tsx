import { expect, userEvent, waitFor, within } from "@storybook/test";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  FastModePreviousServiceTierSchema,
  ServiceTierSchema,
} from "@/common/config/schemas/providersConfig";
import { getModelKey, getReasoningModeKey, getThinkingLevelKey } from "@/common/constants/storage";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import assert from "@/common/utils/assert";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory } from "./helpers/chatSetup";
import { collapseLeftSidebar } from "./helpers/uiState";
import { blurActiveElement, waitForChatInputAutofocusDone } from "./storyPlayHelpers";

export default { ...appMeta, title: "App/Gateway Fast Mode" };

const workspaceId = "ws-gateway-fast-mode";
const phoneViewport = { name: "Phone", styles: { width: "390px", height: "844px" } };

function setupGatewayFastMode(hideSharedPreference = false) {
  collapseLeftSidebar();
  updatePersistedState(getModelKey(workspaceId), "coder:openai/gpt-6-astra");
  updatePersistedState(getThinkingLevelKey(workspaceId), "high");
  updatePersistedState(getReasoningModeKey(workspaceId), "standard");
  let providersConfig: ProvidersConfigMap = {
    coder: {
      apiKeySet: false,
      isEnabled: true,
      isConfigured: true,
      models: ["openai/gpt-6-astra"],
    },
  };
  // An allowed but unconfigured provider still exposes preferences; policy denial omits it.
  if (!hideSharedPreference) {
    providersConfig.openai = { apiKeySet: false, isEnabled: true, isConfigured: false };
  }
  const client = setupSimpleChatStory({
    workspaceId,
    messages: [],
    routePriority: ["coder"],
    providersConfig,
  });
  // Coder supplies credentials; Fast only writes OpenAI's shared tier preference.
  // Keep reads stateful so refreshing configuration cannot silently undo the toggle.
  client.providers.getConfig = () => Promise.resolve(providersConfig);
  client.providers.setProviderConfig = ({ provider, keyPath, value }) => {
    assert(!hideSharedPreference, "Policy-hidden OpenAI preferences must not be written");
    assert(provider === "openai", "Coder Fast must write the upstream OpenAI preference");
    const [key] = keyPath;
    assert(
      keyPath.length === 1 && (key === "serviceTier" || key === "fastModePreviousServiceTier"),
      "Fast must only change the tier and its restore target"
    );
    const parsed =
      value === ""
        ? undefined
        : key === "serviceTier"
          ? ServiceTierSchema.parse(value)
          : FastModePreviousServiceTierSchema.parse(value);
    providersConfig = {
      ...providersConfig,
      openai: {
        ...providersConfig.openai,
        apiKeySet: false,
        isEnabled: true,
        isConfigured: false,
        [key]: parsed,
      },
    };
    return Promise.resolve({ success: true, data: undefined });
  };
  return client;
}

export const Desktop: AppStory = {
  render: () => <AppWithMocks setup={setupGatewayFastMode} />,
  parameters: {
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["laptop"] } },
  },
  play: async ({ canvasElement }) => {
    const root = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(root);
    await waitForChatInputAutofocusDone(root);
    blurActiveElement();
    const trigger = canvas.getByRole("button", { name: /Thinking:/ });

    await userEvent.hover(trigger);
    const tooltip = await within(document.body).findByRole("tooltip");
    const shortcutHint = tooltip.querySelector<HTMLElement>(".mobile-hide-shortcut-hints");
    assert(shortcutHint, "Thinking shortcuts must opt into mobile hint hiding");
    // Pixel does not emulate touch. Real touch runs additionally exercise the CSS hiding rule.
    if (window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches) {
      await expect(shortcutHint).not.toBeVisible();
    }
    await userEvent.unhover(trigger);
    await userEvent.click(trigger);
    const fast = canvas.getByRole("button", { name: /Fast mode/ });
    const effort = canvas.getByRole("option", { name: "High" });
    await expect(fast).toHaveAttribute("aria-pressed", "false");
    await expect(effort).toHaveAttribute("aria-selected", "true");

    await userEvent.click(fast);
    await waitFor(async () => {
      await expect(fast).toBeEnabled();
      await expect(fast).toHaveAttribute("aria-pressed", "true");
      await expect(trigger).toHaveAccessibleName("Thinking: high, fast mode");
      await expect(within(trigger).getByLabelText("Fast mode enabled")).toBeVisible();
    });

    // The same control must be keyboard-operable and restore the original non-Fast tier.
    fast.focus();
    await userEvent.keyboard(" ");
    await waitFor(async () => {
      await expect(fast).toBeEnabled();
      await expect(fast).toHaveAttribute("aria-pressed", "false");
      await expect(trigger).toHaveAccessibleName("Thinking: high");
      await expect(within(trigger).queryByLabelText("Fast mode enabled")).not.toBeInTheDocument();
    });
    await userEvent.click(fast);
    await waitFor(async () => {
      await expect(fast).toBeEnabled();
      await expect(fast).toHaveAttribute("aria-pressed", "true");
      await expect(effort).toHaveAttribute("aria-selected", "true");
      await expect(canvas.getByRole("button", { name: /Pro mode/ })).toHaveAttribute(
        "aria-pressed",
        "false"
      );
    });

    const frame = canvas.queryByTestId("gateway-fast-phone") ?? root;
    const bounds = frame.getBoundingClientRect();
    if (frame !== root) await expect(bounds.width).toBe(390);
    const expectFitsFrame = async (component: string) => {
      await waitFor(async () => {
        const element = root.querySelector<HTMLElement>(`[data-component="${component}"]`);
        assert(element, `${component} must be rendered`);
        await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
        await expect(element.getBoundingClientRect().left).toBeGreaterThanOrEqual(bounds.left);
        await expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right);
      });
    };
    // The absolute menu can extend into the composer's padding without clipping, so measure
    // the closed control row separately from the open menu's own content and frame bounds.
    await userEvent.click(trigger);
    await expectFitsFrame("ComposerControlRow");
    await userEvent.click(trigger);
    await expectFitsFrame("ThinkingSelectorMenu");
    await expect(canvas.getByRole("button", { name: /Fast mode/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    blurActiveElement();
  },
};

export const Phone: AppStory = {
  ...Desktop,
  // The test-runner ignores viewport globals; keep its layout assertions genuinely narrow.
  decorators: [
    (Story) => (
      <div data-testid="gateway-fast-phone" style={{ width: 390, height: 844 }}>
        <Story />
      </div>
    ),
  ],
  globals: { viewport: { value: "gatewayFastPhone", isRotated: false } },
  parameters: {
    viewport: { options: { gatewayFastPhone: phoneViewport } },
    pixel: { matrix: { themes: ["dark", "light"], viewports: ["phone"] } },
  },
  play: async (context) => Desktop.play!(context),
};

export const PolicyHiddenPreference: AppStory = {
  ...Phone,
  render: () => <AppWithMocks setup={() => setupGatewayFastMode(true)} />,
  play: async ({ canvasElement }) => {
    const root = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(root);
    await waitForChatInputAutofocusDone(root);
    blurActiveElement();

    // Denying the shared OpenAI preference must not disable the permitted Coder model.
    const model = canvas.getByRole("combobox");
    await expect(model).toBeEnabled();
    await userEvent.click(model);
    await userEvent.click(canvas.getByRole("option", { name: /Astra/i, selected: true }));
    await expect(model).toHaveAttribute("aria-expanded", "false");
    await expect(model).toHaveTextContent(/Astra/i);

    const trigger = canvas.getByRole("button", { name: /Thinking:/ });
    await userEvent.click(trigger);
    await expect(canvas.getByRole("option", { name: "High" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(trigger).toHaveAccessibleName("Thinking: high");
    await expect(canvas.queryByRole("button", { name: /Fast mode/ })).not.toBeInTheDocument();
    await expect(within(trigger).queryByLabelText("Fast mode enabled")).not.toBeInTheDocument();

    const frame = canvas.getByTestId("gateway-fast-phone").getBoundingClientRect();
    const menu = root.querySelector<HTMLElement>('[data-component="ThinkingSelectorMenu"]');
    assert(menu, "Thinking controls must remain available under Coder-only policy");
    await expect(frame.width).toBe(390);
    await expect(menu.scrollWidth).toBeLessThanOrEqual(menu.clientWidth);
    await expect(menu.getBoundingClientRect().left).toBeGreaterThanOrEqual(frame.left);
    await expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(frame.right);
    blurActiveElement();
  },
};
