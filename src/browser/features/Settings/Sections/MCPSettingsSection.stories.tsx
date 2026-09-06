import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import { CLAUDE_DESIGN_URL } from "@/common/constants/claudeDesign";
import type { ClaudeDesignStatus } from "@/common/orpc/schemas/claudeDesign";
import { useEffect, useRef } from "react";
import type { FC, ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "@storybook/test";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import { ExperimentsProvider } from "@/browser/contexts/ExperimentsContext";
import { PolicyProvider } from "@/browser/contexts/PolicyContext";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { getMCPTestResultsKey } from "@/common/constants/storage";
import type { MCPServerInfo } from "@/common/types/mcp";
import type { MCPOAuthAuthStatus } from "@/common/types/mcpOauth";
import type { Secret } from "@/common/types/secrets";

import { ClaudeDesignCard } from "./ClaudeDesignCard";
import { MCPSettingsSection } from "./MCPSettingsSection";

const MOCK_TOOLS = [
  "file_read",
  "file_write",
  "bash",
  "web_search",
  "web_fetch",
  "todo_write",
  "todo_read",
  "status_set",
];

const POSTHOG_TOOLS = [
  "add-insight-to-dashboard",
  "dashboard-create",
  "dashboard-delete",
  "dashboard-get",
  "dashboards-get-all",
  "dashboard-update",
  "docs-search",
  "error-details",
  "list-errors",
  "create-feature-flag",
  "delete-feature-flag",
  "feature-flag-get-all",
  "experiment-get-all",
  "experiment-create",
];

const GLOBAL_MCP_CACHE_KEY = getMCPTestResultsKey("__global__");

interface MCPSectionStoryOptions {
  servers?: Record<string, MCPServerInfo>;
  mcpOauthAuthStatus?: Map<string, MCPOAuthAuthStatus>;
  testResults?: Record<string, string[]>;
  secrets?: Secret[];
  preCacheTools?: boolean;
}

function setupMCPSettingsSectionStory(options: MCPSectionStoryOptions = {}): APIClient {
  // User rationale: stories should render each scenario directly at the component level,
  // without inheriting stale app-shell MCP cache from prior stories.
  updatePersistedState(GLOBAL_MCP_CACHE_KEY, {});

  if (options.preCacheTools && options.testResults) {
    const cachedResults: Record<
      string,
      {
        result: { success: true; tools: string[] };
        testedAt: number;
      }
    > = {};

    for (const [serverName, tools] of Object.entries(options.testResults)) {
      cachedResults[serverName] = {
        result: { success: true, tools },
        testedAt: Date.now(),
      };
    }

    updatePersistedState(GLOBAL_MCP_CACHE_KEY, cachedResults);
  }

  const mcpTestResults = new Map<string, { success: true; tools: string[] }>();
  if (options.testResults) {
    for (const [serverName, tools] of Object.entries(options.testResults)) {
      mcpTestResults.set(serverName, { success: true, tools });
    }
  }

  return createMockORPCClient({
    globalMcpServers: options.servers ?? {},
    globalSecrets: options.secrets ?? [],
    mcpTestResults,
    mcpOauthAuthStatus: options.mcpOauthAuthStatus,
  });
}

const MCPSettingsSectionStoryShell: FC<{ setup: () => APIClient; children: ReactNode }> = ({
  setup,
  children,
}) => {
  const setupRef = useRef(setup);
  const clientRef = useRef<APIClient | null>(null);
  if (clientRef.current === null || setupRef.current !== setup) {
    setupRef.current = setup;
    clientRef.current = setup();
  }

  return (
    <ThemeProvider>
      <TooltipProvider>
        <APIProvider client={clientRef.current}>
          <ExperimentsProvider>
            <PolicyProvider>{children}</PolicyProvider>
          </ExperimentsProvider>
        </APIProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
};

const withDesktopWindowApi = [
  (Story: FC) => {
    const originalApiRef = useRef(window.api);

    window.api = {
      platform: "darwin",
      versions: {
        node: "20.0.0",
        chrome: "120.0.0",
        electron: "28.0.0",
      },
      isRosetta: false,
    };

    useEffect(() => {
      const savedApi = originalApiRef.current;
      return () => {
        window.api = savedApi;
      };
    }, []);

    return <Story />;
  },
];

const meta: Meta<typeof MCPSettingsSection> = {
  title: "Features/Settings/Sections/MCPSettingsSection",
  component: MCPSettingsSection,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

export const ProjectSettingsEmpty: Story = {
  render: () => (
    <MCPSettingsSectionStoryShell setup={() => setupMCPSettingsSectionStory()}>
      <MCPSettingsSection />
    </MCPSettingsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText("MCP Servers");
    await canvas.findByText("No MCP servers configured yet.");
  },
};

export const ProjectSettingsAddRemoteServerHeaders: Story = {
  parameters: {
    pixel: {
      // Chromium alternates the rounded form border's corner antialiasing by one shade. The full
      // interaction sequence remains covered by Storybook tests.
      exclude: true,
    },
  },
  render: () => (
    <MCPSettingsSectionStoryShell
      setup={() =>
        setupMCPSettingsSectionStory({
          secrets: [
            { key: "MCP_TOKEN", value: "abc123" },
            { key: "MCP_TOKEN_DEV", value: "def456" },
          ],
        })
      }
    >
      <MCPSettingsSection />
    </MCPSettingsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);

    const addServerSummary = await canvas.findByText(/^Add server$/i);
    await userEvent.click(addServerSummary);

    const transportLabel = await canvas.findByText("Transport");
    const transportContainer = transportLabel.closest("div");
    await expect(transportContainer).not.toBeNull();

    const transportSelect = await within(transportContainer as HTMLElement).findByRole("combobox");
    await userEvent.click(transportSelect);

    const httpOption = await body.findByRole("option", { name: /HTTP \(Streamable\)/i });
    await userEvent.click(httpOption);

    const headersLabel = await canvas.findByText(/HTTP headers \(optional\)/i);
    headersLabel.scrollIntoView({ block: "center" });

    const addHeaderButton = await canvas.findByRole("button", { name: /\+ Add header/i });
    await userEvent.click(addHeaderButton);

    const headerNameInputs = await canvas.findAllByPlaceholderText("Authorization");
    await userEvent.type(headerNameInputs[0], "Authorization");

    const secretToggles = await canvas.findAllByRole("radio", { name: "Secret" });
    await userEvent.click(secretToggles[0]);

    await expect(
      canvas.findByRole("button", { name: /Choose secret/i })
    ).resolves.toBeInTheDocument();

    const secretValueInput = await canvas.findByPlaceholderText("MCP_TOKEN");
    await userEvent.type(secretValueInput, "MCP_TOKEN");

    await userEvent.click(addHeaderButton);

    const headerNameInputsAfterSecond = canvas.getAllByPlaceholderText("Authorization");
    await userEvent.type(headerNameInputsAfterSecond[1], "X-Env");

    const textValueInput = await canvas.findByPlaceholderText("value");
    await userEvent.type(textValueInput, "prod");

    await expect(body.findByDisplayValue("Authorization")).resolves.toBeInTheDocument();
    await expect(body.findByDisplayValue("MCP_TOKEN")).resolves.toBeInTheDocument();
    await expect(body.findByDisplayValue("X-Env")).resolves.toBeInTheDocument();
    await expect(body.findByDisplayValue("prod")).resolves.toBeInTheDocument();
  },
};

export const ProjectSettingsWithServers: Story = {
  render: () => (
    <MCPSettingsSectionStoryShell
      setup={() =>
        setupMCPSettingsSectionStory({
          servers: {
            mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: false },
            filesystem: {
              transport: "stdio",
              command: "npx -y @anthropics/filesystem-server /tmp",
              disabled: false,
            },
          },
          testResults: {
            mux: MOCK_TOOLS,
            posthog: POSTHOG_TOOLS,
            filesystem: ["read_file", "write_file", "list_directory"],
          },
          preCacheTools: true,
        })
      }
    >
      <MCPSettingsSection />
    </MCPSettingsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText("mux");
    await canvas.findByText("posthog");
    await canvas.findByText("filesystem");
  },
};

export const ProjectSettingsMixedState: Story = {
  render: () => (
    <MCPSettingsSectionStoryShell
      setup={() =>
        setupMCPSettingsSectionStory({
          servers: {
            mux: { transport: "stdio", command: "npx -y @anthropics/mux-server", disabled: false },
            posthog: { transport: "stdio", command: "npx -y posthog-mcp-server", disabled: true },
            filesystem: {
              transport: "stdio",
              command: "npx -y @anthropics/filesystem-server /tmp",
              disabled: false,
            },
          },
          testResults: {
            mux: MOCK_TOOLS,
            posthog: POSTHOG_TOOLS,
            filesystem: ["read_file", "write_file", "list_directory"],
          },
          preCacheTools: true,
        })
      }
    >
      <MCPSettingsSection />
    </MCPSettingsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText("posthog");
    await canvas.findByText("disabled");
  },
};

export const ProjectSettingsWithToolAllowlist: Story = {
  render: () => (
    <MCPSettingsSectionStoryShell
      setup={() =>
        setupMCPSettingsSectionStory({
          servers: {
            mux: {
              transport: "stdio",
              command: "npx -y @anthropics/mux-server",
              disabled: false,
              toolAllowlist: ["file_read", "file_write", "bash"],
            },
          },
          testResults: {
            mux: MOCK_TOOLS,
          },
          preCacheTools: true,
        })
      }
    >
      <MCPSettingsSection />
    </MCPSettingsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await canvas.findByText("mux");
    await canvas.findByText(/3\/8/);
  },
};

export const ProjectSettingsOAuthNotLoggedIn: Story = {
  decorators: withDesktopWindowApi,
  render: () => (
    <MCPSettingsSectionStoryShell
      setup={() =>
        setupMCPSettingsSectionStory({
          servers: {
            "remote-oauth": {
              transport: "http",
              url: "https://example.com/mcp",
              disabled: false,
            },
          },
          mcpOauthAuthStatus: new Map<string, MCPOAuthAuthStatus>([
            [
              "https://example.com/mcp",
              {
                serverUrl: "https://example.com/mcp",
                isLoggedIn: false,
                hasRefreshToken: false,
              },
            ],
          ]),
        })
      }
    >
      <MCPSettingsSection />
    </MCPSettingsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);

    await body.findByText("remote-oauth");
    await body.findByText("Not logged in");
    await body.findByRole("button", { name: /^Login$/i });
  },
};

export const ProjectSettingsOAuthLoggedIn: Story = {
  decorators: withDesktopWindowApi,
  render: () => (
    <MCPSettingsSectionStoryShell
      setup={() =>
        setupMCPSettingsSectionStory({
          servers: {
            "remote-oauth": {
              transport: "http",
              url: "https://example.com/mcp",
              disabled: false,
            },
          },
          mcpOauthAuthStatus: new Map<string, MCPOAuthAuthStatus>([
            [
              "https://example.com/mcp",
              {
                serverUrl: "https://example.com/mcp",
                isLoggedIn: true,
                hasRefreshToken: true,
                updatedAtMs: Date.now() - 60_000,
              },
            ],
          ]),
        })
      }
    >
      <MCPSettingsSection />
    </MCPSettingsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);

    await body.findByText("remote-oauth");
    await body.findByText(/Logged in/i);

    const [moreActionsButton] = await body.findAllByRole("button", { name: "⋮" });
    if (!moreActionsButton) {
      throw new Error("OAuth actions menu button not found");
    }

    await userEvent.click(moreActionsButton);
    await body.findByRole("button", { name: /Re-login/i });
    await body.findByRole("button", { name: /^Logout$/i });
  },
};

function setupDesignStory(enabled = true, reuseEnabled = false): APIClient {
  updatePersistedState(getExperimentKey(EXPERIMENT_IDS.CLAUDE_DESIGN_MCP), enabled);
  const client = setupMCPSettingsSectionStory({
    servers: enabled
      ? {
          claude_design: {
            transport: "http",
            url: CLAUDE_DESIGN_URL,
            managed: "claude-design",
            disabled: true,
          },
        }
      : {},
  });
  let status: ClaudeDesignStatus = {
    state: reuseEnabled ? "connected" : "disabled",
    backendHost: "remote-backend.example.test",
    platform: "linux",
    settings: {
      source: { type: "file", path: "/home/example/.claude/.credentials.json" },
      reuseEnabled,
      serverEnabled: false,
    },
  };
  client.mcp.designStatus = () => Promise.resolve(status);
  client.mcp.configureDesign = (settings) => {
    status = {
      ...status,
      settings: { ...status.settings, ...settings },
      state: settings.reuseEnabled ? "not_configured" : "disabled",
    };
    return Promise.resolve(status);
  };
  client.mcp.test = () => {
    status = { ...status, state: "consent_required" };
    return Promise.resolve({ success: false, error: "Claude Design: consent_required" });
  };
  return client;
}

export const ClaudeDesignOptIn: Story = {
  tags: ["claude-design"],
  render: () => (
    <MCPSettingsSectionStoryShell setup={() => setupDesignStory()}>
      <MCPSettingsSection />
    </MCPSettingsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const connect = await canvas.findByRole("button", { name: "Use Claude Code credentials" });
    await expect(canvas.queryByRole("button", { name: "Login" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Edit server" })).toBeNull();
    await expect(canvas.getByRole("button", { name: "Disconnect" })).toBeDisabled();
    await userEvent.click(connect);
    await canvas.findByText(/Design requires consent/);
    await userEvent.click(canvas.getByRole("button", { name: "Disconnect" }));
    await canvas.findByRole("button", { name: "Use Claude Code credentials" });
    await expect(canvas.getByRole("button", { name: "Disconnect" })).toBeDisabled();
  },
};

export const ClaudeDesignPhone: Story = {
  ...ClaudeDesignOptIn,
  tags: ["claude-design"],
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { pixel: { matrix: { viewports: ["phone"] } } },
  // The test-runner ignores viewport globals; the wrapper enforces the contract there too.
  render: () => (
    <div style={{ width: 375, maxWidth: "100%" }}>
      <MCPSettingsSectionStoryShell setup={() => setupDesignStory()}>
        <MCPSettingsSection />
      </MCPSettingsSectionStoryShell>
    </div>
  ),
  play: async (context) => {
    await ClaudeDesignOptIn.play?.(context);
    const card = within(context.canvasElement).getByRole("region", { name: "Claude Design" });
    await expect(card.getBoundingClientRect().width).toBeLessThanOrEqual(375);
    await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
  },
};

export const ClaudeDesignDisabled: Story = {
  tags: ["claude-design"],
  render: () => (
    <MCPSettingsSectionStoryShell setup={() => setupDesignStory(false)}>
      <MCPSettingsSection />
    </MCPSettingsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("No MCP servers configured yet.");
    await expect(canvas.queryByRole("region", { name: "Claude Design" })).toBeNull();
  },
};

export const ClaudeDesignConflictDisconnect: Story = {
  tags: ["claude-design"],
  render: () => (
    <MCPSettingsSectionStoryShell setup={() => setupDesignStory(true, true)}>
      <ClaudeDesignCard conflict remoteDisabled={false} onChange={() => Promise.resolve()} />
    </MCPSettingsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const disconnect = await canvas.findByRole("button", { name: "Disconnect" });
    await expect(canvas.getByRole("button", { name: "Retry connection" })).toBeDisabled();
    await expect(disconnect).toBeEnabled();
    await userEvent.click(disconnect);
    await canvas.findByRole("button", { name: "Use Claude Code credentials" });
    await expect(canvas.getByRole("button", { name: "Disconnect" })).toBeDisabled();
  },
};

export const ClaudeDesignPolicyDisconnect: Story = {
  ...ClaudeDesignConflictDisconnect,
  tags: ["claude-design"],
  render: () => (
    <MCPSettingsSectionStoryShell setup={() => setupDesignStory(true, true)}>
      <ClaudeDesignCard conflict={false} remoteDisabled onChange={() => Promise.resolve()} />
    </MCPSettingsSectionStoryShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const disconnect = await canvas.findByRole("button", { name: "Disconnect" });
    await expect(canvas.getByRole("button", { name: "Retry connection" })).toBeDisabled();
    await expect(disconnect).toBeEnabled();
    disconnect.focus();
    await userEvent.keyboard("{Control>}{Shift>}d{/Shift}{/Control}");
    await canvas.findByRole("button", { name: "Use Claude Code credentials" });
    await expect(canvas.getByRole("button", { name: "Disconnect" })).toBeDisabled();
  },
};
