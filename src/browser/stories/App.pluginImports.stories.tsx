import { expect, userEvent, waitFor, within } from "@storybook/test";
import { appMeta, AppWithMocks, type AppStory } from "./meta";
import { expandLeftSidebar } from "./helpers/uiState";
import { setupSettingsStory } from "@/browser/features/Settings/Sections/settingsStoryUtils";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { AgentPluginInstallPreview } from "@/common/orpc/schemas/agentPlugins";
import type { AgentPluginInstallEntry } from "@/common/config/schemas/agentPluginInstalls";

export default { ...appMeta, title: "App/PluginImports" };

const preview: AgentPluginInstallPreview = {
  source: {
    type: "git",
    url: "https://github.com/example/review-tools.git",
    ref: "main",
    refType: "branch",
  },
  lockedSha: "a".repeat(40),
  manifest: { name: "review-tools", version: "1.0.0", description: "Review and research tools" },
  targetPath: "~/.xum/plugins/review-tools",
  skills: [
    { name: "review", description: "Review a change" },
    { name: "research", description: "Research a topic" },
  ],
  mcpServers: [
    {
      serverName: "reference",
      transport: "stdio",
      summary: "node ${PLUGIN_ROOT}/servers/reference.js --read-only",
    },
  ],
  agents: ["reviewer.md"],
  workflows: ["review.js"],
  slashCommands: [{ name: "review-status", description: "Summarize review status" }],
  hook: { path: "hooks.js", toolGrants: ["file_read"] },
  warnings: [],
};

function setupPluginSettings(installed = false) {
  expandLeftSidebar();
  const client = setupSettingsStory({ experiments: { [EXPERIMENT_IDS.AGENT_PLUGINS]: true } });
  let entry: AgentPluginInstallEntry = {
    name: preview.manifest.name,
    scope: "global",
    source: preview.source,
    lockedSha: preview.lockedSha,
    installedAt: "2026-09-01T00:00:00.000Z",
    importedComponents: { skills: ["review"], mcpServers: [] },
  };
  client.agentPlugins.preview = () => Promise.resolve({ success: true, data: preview });
  client.agentPlugins.checkUpdates = () => Promise.resolve({ success: true, data: [] });
  client.agentPlugins.list = () =>
    Promise.resolve({
      success: true,
      data: installed
        ? [
            {
              ...entry,
              managed: true,
              present: true,
              location: preview.targetPath,
              skillCount: 2,
              mcpServerCount: 1,
              importedSkillCount: entry.importedComponents?.skills.length ?? 2,
              importedMcpServerCount: entry.importedComponents?.mcpServers.length ?? 1,
            },
          ]
        : [],
    });
  client.agentPlugins.getComponents = () =>
    Promise.resolve({
      success: true,
      data: { ...preview, importedComponents: entry.importedComponents },
    });
  client.agentPlugins.install = (input) => {
    installed = true;
    entry = { ...entry, importedComponents: input.importedComponents ?? undefined };
    return Promise.resolve({ success: true, data: entry });
  };
  client.agentPlugins.addComponents = (input) => {
    entry = {
      ...entry,
      importedComponents: {
        skills: [...new Set([...(entry.importedComponents?.skills ?? []), ...input.skills])],
        mcpServers: [
          ...new Set([...(entry.importedComponents?.mcpServers ?? []), ...input.mcpServers]),
        ],
      },
    };
    return Promise.resolve({ success: true, data: entry });
  };
  return client;
}

async function openPlugins(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByTestId("settings-button", {}, { timeout: 10000 }));
  await userEvent.click(await canvas.findByRole("button", { name: "Plugins" }));
  return canvas;
}

async function checkPhoneBounds(canvasElement: HTMLElement) {
  // CI's test-runner ignores viewport globals; only check narrow bounds when actually pinned.
  if (window.innerWidth >= 768) return;
  await waitFor(() =>
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
  );
  for (const group of within(canvasElement).getAllByRole("group")) {
    await expect(group.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  }
}

export const PreviewDesktop: AppStory = {
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark", "light"], viewports: ["desktop"] } } },
  render: () => <AppWithMocks setup={setupPluginSettings} />,
  play: async ({ canvasElement }) => {
    const canvas = await openPlugins(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Add plugin" }));
    await userEvent.type(canvas.getByLabelText("Git URL or owner/repo"), "example/review-tools");
    await userEvent.click(canvas.getByRole("button", { name: "Preview" }));
    for (const label of ["Skills", "MCP servers"]) {
      const group = within(await canvas.findByRole("group", { name: label }));
      await userEvent.click(group.getByRole("button", { name: "Clear" }));
      for (const checkbox of group.getAllByRole("checkbox"))
        await expect(checkbox).not.toBeChecked();
    }
    await expect(canvas.getByRole("button", { name: "Install" })).toBeEnabled();
    await checkPhoneBounds(canvasElement);
    canvas.getByRole("group", { name: "Skills" }).scrollIntoView({ block: "start" });
  },
};

export const PreviewPhone: AppStory = {
  ...PreviewDesktop,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark"], viewports: ["phone"] } } },
};

export const AddComponentsDesktop: AppStory = {
  ...PreviewDesktop,
  render: () => <AppWithMocks setup={() => setupPluginSettings(true)} />,
  play: async ({ canvasElement }) => {
    const canvas = await openPlugins(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add components to review-tools" })
    );
    await expect(await canvas.findByRole("checkbox", { name: "review" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Import selected" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("checkbox", { name: "research" }));
    await expect(canvas.getByRole("button", { name: "Import selected" })).toBeEnabled();
    await checkPhoneBounds(canvasElement);
  },
};

export const AddComponentsPhone: AppStory = {
  ...AddComponentsDesktop,
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { themes: ["dark"], viewports: ["phone"] } } },
};
