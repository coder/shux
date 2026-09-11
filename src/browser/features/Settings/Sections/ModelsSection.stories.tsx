/**
 * NOTE: ModelsSection contains an in-app CTA ("Go to Agent defaults") that calls
 * openSettings("tasks"). In isolated section stories the CTA navigates to the
 * agents section via settings context, but the visual section swap is only
 * exercised in the SettingsPage smoke story.
 */
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor, within } from "@storybook/test";
import { ModelsSection } from "./ModelsSection.js";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/ModelsSection",
  component: ModelsSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ModelsEmpty: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() =>
        setupSettingsStory({
          providersConfig: {
            anthropic: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: [],
            },
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: [],
            },
          },
        })
      }
    >
      <ModelsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        if (canvas.queryAllByText(/Built-in Models/i).length === 0) {
          throw new Error("Expected Built-in Models to render");
        }
      },
      { timeout: 5000 }
    );
  },
};

export const ModelsConfigured: Story = {
  render: () => (
    <SettingsSectionStory
      setup={() => {
        window.localStorage.setItem(
          "provider_options_anthropic",
          JSON.stringify({ use1MContextModels: ["anthropic:claude-sonnet-4-20250514"] })
        );

        return setupSettingsStory({
          modelClasses: {
            large: "anthropic:claude-opus-4-8+max",
            // xai is deliberately unconfigured in this story: exercises the
            // "no configured route" warning on the medium row.
            medium: "xai:grok-beta",
            small: "anthropic:claude-sonnet-4-20250514+0",
            // Hand-edited custom class with a long unbroken model id: pins
            // the custom-classes line's wrap treatment at phone width (the
            // pinned ModelsConfiguredPhone variant snapshots this).
            "batch-experiments":
              "someproxy:organization-research/experimental-preview-20260815-extended-context",
          },
          providersConfig: {
            anthropic: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: ["claude-sonnet-4-20250514", "claude-opus-4-8"],
            },
            openai: {
              apiKeySet: true,
              isEnabled: true,
              isConfigured: true,
              baseUrl: "",
              models: ["gpt-4o", "gpt-4o-mini", "o1-preview"],
            },
            xai: {
              apiKeySet: false,
              isEnabled: true,
              isConfigured: false,
              baseUrl: "",
              models: ["grok-beta"],
            },
          },
        });
      }}
    >
      <ModelsSection />
    </SettingsSectionStory>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await waitFor(
      () => {
        if (canvas.queryAllByText(/claude-sonnet-4-20250514/i).length === 0) {
          throw new Error("Expected claude-sonnet-4-20250514 to render");
        }
      },
      { timeout: 5000 }
    );

    await waitFor(
      () => {
        if (canvas.queryAllByText(/^gpt-4o$/i).length === 0) {
          throw new Error("Expected gpt-4o to render");
        }
      },
      { timeout: 5000 }
    );
  },
};

/**
 * Pinned phone-width snapshot of the configured state: the Model Classes rows
 * wrap their label/select layout at narrow widths, and without an explicit
 * Pixel phone variant CI would only ever snapshot the desktop layout the
 * wrapping is meant to protect against. globals.viewport mirrors the Pixel
 * matrix so local Storybook shows the same width.
 */
export const ModelsConfiguredPhone: Story = {
  ...ModelsConfigured,
  globals: {
    viewport: { value: "pixelPhone", isRotated: false },
  },
  parameters: {
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
};
