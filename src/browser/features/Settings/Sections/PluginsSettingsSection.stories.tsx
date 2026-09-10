import { useRef } from "react";
import type { FC, ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "@storybook/test";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { createMockORPCClient, type MockORPCClientOptions } from "@/browser/stories/mocks/orpc";
import type { AgentPluginListItem } from "@/common/orpc/schemas/agentPlugins";

import { PluginsSettingsSection } from "./PluginsSettingsSection";

const MANAGED_ITEM: AgentPluginListItem = {
  name: "grill",
  managed: true,
  present: true,
  location: "~/.mux/plugins/grill",
  version: "1.2.0",
  description: "Relentlessly grills your plans before you commit to them.",
  source: {
    type: "git",
    url: "https://github.com/example/grill.git",
    ref: "main",
    refType: "branch",
  },
  lockedSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  installedAt: "2026-08-01T12:00:00.000Z",
  skillCount: 3,
  mcpServerCount: 1,
};

const PINNED_ITEM: AgentPluginListItem = {
  name: "deploy-tools",
  managed: true,
  present: true,
  location: "~/.mux/plugins/deploy-tools",
  version: "2.0.0",
  source: {
    type: "git",
    url: "git@git.corp:infra/deploy-tools.git",
    ref: "v2.0.0",
    refType: "tag",
  },
  lockedSha: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
  installedAt: "2026-07-15T09:30:00.000Z",
  skillCount: 0,
  mcpServerCount: 2,
};

const UNMANAGED_ITEM: AgentPluginListItem = {
  name: "handmade",
  managed: false,
  present: true,
  location: "~/.agents/plugins/handmade",
  description: "Copied into the container by hand; Mux lists it read-only.",
  skillCount: 1,
  mcpServerCount: 0,
};

const MISSING_ITEM: AgentPluginListItem = {
  name: "vanished",
  managed: true,
  present: false,
  location: "~/.mux/plugins/vanished",
  version: "0.4.0",
  source: {
    type: "git",
    url: "https://github.com/example/vanished.git",
    ref: "main",
    refType: "branch",
  },
  lockedSha: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2",
  installedAt: "2026-06-01T00:00:00.000Z",
  skillCount: 0,
  mcpServerCount: 0,
};

/** Valid max-length (64-char, separator-free) name: the worst case for narrow-width wrapping. */
const MAX_LENGTH_NAME = "a".repeat(64);
const MAX_LENGTH_ITEM: AgentPluginListItem = {
  name: MAX_LENGTH_NAME,
  managed: true,
  present: true,
  location: `~/.mux/plugins/${MAX_LENGTH_NAME}`,
  version: "1.0.0",
  source: {
    type: "git",
    url: `https://github.com/example/${MAX_LENGTH_NAME}.git`,
    ref: "main",
    refType: "branch",
  },
  lockedSha: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
  installedAt: "2026-08-01T12:00:00.000Z",
  skillCount: 1,
  mcpServerCount: 0,
};

const PluginsSectionStoryShell: FC<{ options: MockORPCClientOptions; children: ReactNode }> = (
  props
) => {
  const clientRef = useRef<APIClient | null>(null);
  clientRef.current ??= createMockORPCClient(props.options);

  return (
    <ThemeProvider>
      <TooltipProvider>
        <APIProvider client={clientRef.current}>
          <ExperimentsProvider>{props.children}</ExperimentsProvider>
        </APIProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
};

const meta: Meta<typeof PluginsSettingsSection> = {
  title: "Features/Settings/Sections/PluginsSettingsSection",
  component: PluginsSettingsSection,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  render: () => (
    <PluginsSectionStoryShell options={{ agentPlugins: { items: [] } }}>
      <PluginsSettingsSection />
    </PluginsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Installed plugins");
    await canvas.findByText("No plugins installed yet.");
  },
};

export const InstalledWithUpdateStates: Story = {
  render: () => (
    <PluginsSectionStoryShell
      options={{
        agentPlugins: {
          items: [MANAGED_ITEM, PINNED_ITEM, UNMANAGED_ITEM, MISSING_ITEM],
          updateChecks: [
            {
              name: "grill",
              status: "update-available",
              remoteSha: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
            },
            { name: "deploy-tools", status: "tag-moved" },
            { name: "vanished", status: "error", message: "Could not reach the remote." },
          ],
        },
      }}
    >
      <PluginsSettingsSection />
    </PluginsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText("grill");
    await canvas.findByText("update available");
    await canvas.findByText("tag moved");
    await canvas.findByText("unmanaged");
    await canvas.findByText("missing");
    // Update action appears only for rows whose tracking ref moved.
    await canvas.findAllByRole("button", { name: /Update/ });
  },
};

/**
 * Pinned phone viewport for the row layout: long repo paths, badge clusters,
 * and the action group must not overflow the right edge or starve each other
 * at narrow widths (AGENTS.md Storybook responsive rule).
 */
export const InstalledPhoneViewport: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    layout: "fullscreen",
    pixel: {
      matrix: { themes: ["dark"], viewports: ["phone"] },
    },
  },
  render: () => (
    <PluginsSectionStoryShell
      options={{
        agentPlugins: {
          items: [MANAGED_ITEM, PINNED_ITEM, UNMANAGED_ITEM, MAX_LENGTH_ITEM],
          updateChecks: [
            {
              name: "grill",
              status: "update-available",
              remoteSha: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
            },
          ],
        },
      }}
    >
      {/* Fixed phone width so the play's overflow assertion holds in the CI
          test-runner too, which ignores viewport globals (AGENTS.md). */}
      <div style={{ width: 390 }}>
        <PluginsSettingsSection />
      </div>
    </PluginsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("grill");
    await canvas.findByText("update available");
    await canvas.findByRole("button", { name: /Update/ });
    // Max-length separator-free names must wrap instead of overflowing the
    // card's right edge at phone width.
    const maxRow = await canvas.findByText(MAX_LENGTH_NAME);
    const card = maxRow.closest("div[class*='rounded-md']");
    if (card instanceof HTMLElement && card.scrollWidth > card.clientWidth + 1) {
      throw new Error("Max-length plugin row overflows its card at phone width");
    }
  },
};

/** An unmanaged plugin sharing the MANAGED_ITEM's manifest name (a supported
 * container state: `~/.agents/plugins` is user-populated). The uninstall
 * confirmation is keyed by name, so it must additionally anchor on the
 * managed row — never under this read-only doppelganger. */
const UNMANAGED_SAME_NAME_ITEM: AgentPluginListItem = {
  name: "grill",
  managed: false,
  present: true,
  location: "~/.agents/plugins/grill",
  description: "Same manifest name in another container; Mux lists it read-only.",
  skillCount: 1,
  mcpServerCount: 0,
};

export const UninstallConfirmation: Story = {
  render: () => (
    // Unmanaged doppelganger FIRST: a purely name-keyed confirmation would
    // render under it too (and before the managed row).
    <PluginsSectionStoryShell
      options={{ agentPlugins: { items: [UNMANAGED_SAME_NAME_ITEM, MANAGED_ITEM] } }}
    >
      <PluginsSettingsSection />
    </PluginsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const uninstallButton = await canvas.findByRole("button", { name: /Uninstall grill/ });
    await userEvent.click(uninstallButton);

    // Preserve-by-default: the plugin-data checkbox starts unchecked.
    await canvas.findByText(/Also delete stored plugin data/);
    const confirms = canvas.getAllByText(/Also delete stored plugin data/);
    if (confirms.length !== 1) {
      throw new Error(
        `Uninstall confirmation must render exactly once (managed row), found ${confirms.length}`
      );
    }
    // ...and under the MANAGED row: confirming a card that visually belongs
    // to the read-only unmanaged plugin would still uninstall the managed one.
    // closest() from the label lands on the confirm panel's own rounded div,
    // so hop to its parent (the row card) before checking the row identity.
    const panel = confirms[0].closest("div[class*='rounded-md']");
    const rowCard = panel?.parentElement?.closest("div[class*='rounded-md']");
    if (
      !(rowCard instanceof HTMLElement) ||
      !rowCard.textContent?.includes("~/.mux/plugins/grill")
    ) {
      throw new Error("Uninstall confirmation must anchor on the managed row");
    }
    const checkbox = await canvas.findByRole("checkbox");
    if (checkbox.getAttribute("data-state") !== "unchecked") {
      throw new Error("Plugin-data checkbox must start unchecked (preserve by default)");
    }
  },
};

export const AddPluginConsentPreview: Story = {
  render: () => (
    <PluginsSectionStoryShell
      options={{
        agentPlugins: {
          items: [],
          preview: {
            source: {
              type: "git",
              url: "https://github.com/example/grill.git",
              ref: "main",
              refType: "branch",
            },
            lockedSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
            manifest: {
              name: "grill",
              version: "1.2.0",
              description: "Relentlessly grills your plans.",
              authorName: "Example Co",
              license: "MIT",
            },
            skills: [
              { name: "grill", description: "Stress-test a plan before committing to it." },
              { name: "grill-lite", description: "A gentler grilling for small changes." },
            ],
            mcpServers: [
              {
                serverName: "grill-db",
                transport: "stdio",
                summary: "node ~/.mux/plugins/grill/server.js --db ${PLUGIN_DATA}/state.sqlite",
              },
            ],
            agents: ["grill-master.md"],
            workflows: ["grill-report.js"],
            slashCommands: [{ name: "grill", description: "Grill the current plan" }],
            warnings: ["Unknown top-level field 'hooks' ignored"],
            targetPath: "~/.mux/plugins/grill",
          },
        },
      }}
    >
      <PluginsSettingsSection />
    </PluginsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /Add plugin/ }));
    await userEvent.type(await canvas.findByLabelText(/Git URL or owner\/repo/), "example/grill");
    await userEvent.click(await canvas.findByRole("button", { name: /Preview/ }));

    // Consent card: manifest + every skill + every MCP command line before install.
    await canvas.findByRole("group", { name: "Skills" });
    await canvas.findByRole("checkbox", { name: "grill-lite" });
    await canvas.findByRole("group", { name: "MCP servers" });
    await canvas.findByText(/server\.js --db/);
    // Every activatable component type is disclosed, not just skills/MCP.
    await canvas.findByText("Agents (1)");
    await canvas.findByText(/grill-master\.md/);
    await canvas.findByText("Workflows (1)");
    await canvas.findByText(/grill-report\.js/);
    await canvas.findByText("Slash commands (1)");
    await canvas.findByText("/grill");
    await canvas.findByText(/Unknown top-level field 'hooks' ignored/);
    await canvas.findByRole("button", { name: /Install/ });
  },
};

/**
 * Pinned phone viewport for the consent preview: the source URL and target
 * path line carries a 64-char separator-free plugin dir name (no natural
 * break points) and must wrap instead of overflowing the card
 * (AGENTS.md Storybook responsive rule).
 */
export const AddPluginConsentPreviewPhoneViewport: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    layout: "fullscreen",
    pixel: {
      matrix: { themes: ["dark"], viewports: ["phone"] },
    },
  },
  render: () => (
    <PluginsSectionStoryShell
      options={{
        agentPlugins: {
          items: [],
          preview: {
            source: {
              type: "git",
              url: `https://github.com/example/${MAX_LENGTH_NAME}.git`,
              ref: "main",
              refType: "branch",
            },
            lockedSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
            manifest: { name: MAX_LENGTH_NAME, version: "1.0.0" },
            skills: [],
            mcpServers: [],
            agents: [],
            workflows: [],
            slashCommands: [],
            warnings: [],
            targetPath: `~/.mux/plugins/${MAX_LENGTH_NAME}`,
          },
        },
      }}
    >
      {/* Fixed phone width so the play's overflow assertion holds in the CI
          test-runner too, which ignores viewport globals (AGENTS.md). */}
      <div style={{ width: 390 }}>
        <PluginsSettingsSection />
      </div>
    </PluginsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(await canvas.findByRole("button", { name: /Add plugin/ }));
    await userEvent.type(
      await canvas.findByLabelText(/Git URL or owner\/repo/),
      `example/${MAX_LENGTH_NAME}`
    );
    await userEvent.click(await canvas.findByRole("button", { name: /Preview/ }));

    // The separator-free target path must wrap instead of overflowing the
    // consent card's right edge at phone width.
    const pathCode = await canvas.findByText(`~/.mux/plugins/${MAX_LENGTH_NAME}`);
    const card = pathCode.closest("div[class*='rounded-md']");
    if (!(card instanceof HTMLElement)) {
      throw new Error("Consent preview card not found");
    }
    if (card.scrollWidth > card.clientWidth + 1) {
      throw new Error("Consent preview overflows its card at phone width");
    }
  },
};

const UPDATE_REVIEW_OPTIONS: MockORPCClientOptions = {
  agentPlugins: {
    items: [MANAGED_ITEM],
    updateChecks: [
      {
        name: "grill",
        status: "update-available",
        remoteSha: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
      },
    ],
    updateReview: {
      name: "grill",
      fromSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      toSha: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
      version: "1.3.0",
      changes: [
        {
          summary: "changes the model-visible advertisement of skill 'grilling'",
          before: "Grill the user about a plan or decision.",
          after:
            "Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking.",
        },
        {
          summary: "adds MCP server 'planner'",
          after: "node ~/.mux/plugins/grill/server.js --port 0",
        },
      ],
      warnings: [],
    },
  },
};

/**
 * Update → inline capability review. The pending update rewords a skill's
 * model-visible description and adds an MCP server, so Update opens the
 * review panel (before/after per change) instead of applying, and nothing is
 * installed until "Apply update" is pressed.
 */
export const UpdateRequiresReview: Story = {
  render: () => (
    <PluginsSectionStoryShell options={UPDATE_REVIEW_OPTIONS}>
      <PluginsSettingsSection />
    </PluginsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /^Update$/ }));
    // Review panel replaces the direct apply: both changes are listed with
    // their consented/staged values, and the apply button awaits consent.
    await canvas.findByText(/changes the model-visible advertisement of skill 'grilling'/);
    await canvas.findByText("Grill the user about a plan or decision.");
    await canvas.findByText(/adds MCP server 'planner'/);
    await canvas.findByRole("button", { name: /Apply update/ });
  },
};

/**
 * Update review at phone width: long capability summaries, before/after
 * values, and MCP command lines must wrap inside the card instead of
 * overflowing its right edge.
 */
export const UpdateRequiresReviewPhoneViewport: Story = {
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  parameters: {
    layout: "fullscreen",
    pixel: {
      matrix: { themes: ["dark"], viewports: ["phone"] },
    },
  },
  render: () => (
    <PluginsSectionStoryShell options={UPDATE_REVIEW_OPTIONS}>
      {/* Fixed phone width so the play's overflow assertion holds in the CI
          test-runner too, which ignores viewport globals (AGENTS.md). */}
      <div style={{ width: 390 }}>
        <PluginsSettingsSection />
      </div>
    </PluginsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /^Update$/ }));
    const applyButton = await canvas.findByRole("button", { name: /Apply update/ });
    const card = applyButton.closest("div[class*='rounded-md']");
    if (!(card instanceof HTMLElement)) {
      throw new Error("Update review card not found");
    }
    if (card.scrollWidth > card.clientWidth + 1) {
      throw new Error("Update review overflows its card at phone width");
    }
  },
};
