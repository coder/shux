import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { BackupSection } from "./BackupSection.js";
import { SettingsSectionStory } from "./settingsStoryUtils.js";

const meta: Meta = {
  ...lightweightMeta,
  title: "Settings/Sections/BackupSection",
  component: BackupSection,
};

export default meta;
type Story = StoryObj<typeof meta>;

function renderBackupSection() {
  return (
    <SettingsSectionStory
      setup={() =>
        createMockORPCClient({
          backupSettings: {
            repoUrl: "git@github.com:example/dotfiles.git",
            branch: "main",
            path: "xum/",
          },
          backupValidation: {
            reachable: true,
            empty: false,
            credential: "gh",
          },
          backupPreview: {
            pushChanges: [
              { status: "M", path: "mux/preferences.json" },
              { status: "A", path: "mux/memory/global/preferences.md" },
            ],
            restoreChanges: [
              { status: "M", path: "preferences.json" },
              { status: "A", path: "skills/release/SKILL.md" },
            ],
            localOnlyFiles: ["agents/local-only.md"],
            redactions: ["mcp.jsonc: github.headers.Authorization"],
            commandApprovals: [
              {
                path: "servers.notes.command",
                command: "npx -y @modelcontextprotocol/server-filesystem /home/dev/notes",
                token: "8d2e4787fcc88a36cbd9067997213f1a791ec3999af6e9bf2259f6f3a1a0337e",
              },
            ],
            projectImports: [
              {
                sourcePath: "/home/dev/src/rocket",
                name: "rocket",
                gitRemote: "git@github.com:dev/rocket.git",
                memoryFileCount: 3,
                token: "1f4c9a2b8d6e0f31a5c7e9b2d4f6081a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1e3b",
              },
            ],
            projectBundleSkipped: false,
            pushError: null,
          },
        })
      }
    >
      <div className="bg-background min-h-screen p-4 sm:p-6">
        <BackupSection />
      </div>
    </SettingsSectionStory>
  );
}

export const Configured: Story = {
  render: renderBackupSection,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Settings backup");
    await userEvent.click(canvas.getByRole("button", { name: "Validate" }));
    await canvas.findByText(/Credential used: GitHub CLI/i);
    await userEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    await canvas.findByText("Backup to repository");
    await canvas.findByText("Restore to this device");
    await canvas.findByText(/github\.headers\.Authorization/i);
    await canvas.findByText("agents/local-only.md");
    await canvas.findByRole("checkbox", { name: "Approve MCP command changes" });
    await canvas.findByText("Projects to reimport");
  },
};

export const Phone: Story = {
  globals: {
    viewport: { value: "mobile2", isRotated: false },
  },
  parameters: {
    pixel: {
      matrix: { themes: ["dark", "light"], viewports: ["phone"] },
    },
  },
  render: renderBackupSection,
  // The import cards only exist after a preview, so the pinned phone snapshot must open
  // one or it never exercises the narrow card layout and its long repository-controlled
  // strings.
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Settings backup");
    await userEvent.click(canvas.getByRole("button", { name: "Preview changes" }));
    await canvas.findByText("Projects to reimport");
    await canvas.findByRole("checkbox", { name: /Import project/ });
  },
};
