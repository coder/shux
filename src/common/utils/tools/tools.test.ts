/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";

import { Ok } from "@/common/types/result";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import {
  getForcedXaiSearchToolNames,
  getToolsForModel,
  supportsAnthropicNativeWebFetch,
  type ToolConfiguration,
  type WorkspaceHeartbeatToolService,
} from "./tools";
const DESKTOP_TOOL_NAMES = [
  "desktop_screenshot",
  "desktop_move_mouse",
  "desktop_click",
  "desktop_double_click",
  "desktop_drag",
  "desktop_scroll",
  "desktop_type",
  "desktop_key_press",
] as const;

function createInitStateManager(): InitStateManager {
  return {
    waitForInit: () => Promise.resolve(),
  } as unknown as InitStateManager;
}

function createDesktopSessionManager(options: { available: boolean }) {
  const getCapability = mock(() =>
    Promise.resolve(
      options.available
        ? {
            available: true as const,
            width: 1920,
            height: 1080,
            sessionId: "desktop:test-workspace",
          }
        : {
            available: false as const,
            reason: "disabled" as const,
          }
    )
  );

  return {
    desktopSessionManager: {
      getCapability,
      screenshot: mock(() =>
        Promise.resolve({
          imageBase64: "cG5nLWRhdGE=",
          mimeType: "image/png" as const,
          width: 1920,
          height: 1080,
        })
      ),
      action: mock(() => Promise.resolve({ success: true as const })),
    } as unknown as DesktopSessionManager,
    getCapability,
  };
}

describe("supportsAnthropicNativeWebFetch", () => {
  test.each([
    // Major-only "5 generation" IDs (dateless naming): Sonnet 5, Opus 5, Fable 5, Mythos 5.
    ["claude-sonnet-5", true],
    ["claude-opus-5", true],
    ["claude-fable-5", true],
    ["claude-mythos-5", true],
    // Two-segment IDs at/after the 4.6 cutoff.
    ["claude-fable-5-1", true],
    ["claude-mythos-5-1", true],
    ["claude-sonnet-4-6", true],
    ["claude-opus-4-6", true],
    ["claude-opus-4-8", true],
    ["claude-opus-4-6-20260201", true],
    // Below the 4.6 cutoff.
    ["claude-sonnet-4-5", false],
    ["claude-haiku-4-5", false],
    // Date-based pre-4.6 ID must parse as major=4 / no minor and stay unsupported,
    // not misread the 8-digit date as a minor version.
    ["claude-sonnet-4-20250514", false],
    // Older Claude 3.x IDs encode the family before the variant; do not misread
    // `3-5` or `3-7` as variant=3, major=5/7.
    ["claude-3-5-sonnet-20241022", false],
    ["claude-3-7-sonnet-20250219", false],
  ] as const)("%s -> %s", (modelId, expected) => {
    expect(supportsAnthropicNativeWebFetch(modelId)).toBe(expected);
  });
});

describe("getToolsForModel", () => {
  test("only includes agent_report when enableAgentReport=true", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const toolsWithoutReport = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        enableAgentReport: false,
      },
      "ws-1",
      initStateManager
    );
    expect(toolsWithoutReport.agent_report).toBeUndefined();

    const toolsWithReport = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        enableAgentReport: true,
      },
      "ws-1",
      initStateManager
    );
    expect(toolsWithReport.agent_report).toBeDefined();
  });

  test("only includes family messaging tools when enableFamilyMessaging=true", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    // A plain sub-agent session (agent_report on, no RLM spawn stamp) must not see
    // the family messaging tools.
    const toolsWithout = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        enableAgentReport: true,
      },
      "ws-1",
      initStateManager
    );
    expect(toolsWithout.task_message_parent).toBeUndefined();
    expect(toolsWithout.task_message_sibling).toBeUndefined();

    const toolsWith = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        enableAgentReport: true,
        enableFamilyMessaging: true,
      },
      "ws-1",
      initStateManager
    );
    expect(toolsWith.task_message_parent).toBeDefined();
    expect(toolsWith.task_message_sibling).toBeDefined();
  });

  test("includes heartbeat only when the heartbeat service and experiment are configured", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const toolsWithoutHeartbeat = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        experiments: { workspaceHeartbeats: true },
      },
      "ws-1",
      initStateManager
    );
    expect(toolsWithoutHeartbeat.heartbeat).toBeUndefined();

    const heartbeatService: WorkspaceHeartbeatToolService = {
      getHeartbeatSettings: mock(() => null),
      setHeartbeatSettings: mock(() =>
        Promise.resolve(
          Ok({ enabled: true, intervalMs: 30 * 60 * 1000, contextMode: "normal" as const })
        )
      ),
      unsetHeartbeatSettings: mock(() => Promise.resolve(Ok(undefined))),
    };
    const toolsWithExperimentDisabled = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        workspaceHeartbeatService: heartbeatService,
      },
      "ws-1",
      initStateManager
    );
    expect(toolsWithExperimentDisabled.heartbeat).toBeUndefined();

    const toolsWithHeartbeat = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        experiments: { workspaceHeartbeats: true },
        workspaceHeartbeatService: heartbeatService,
      },
      "ws-1",
      initStateManager
    );
    const childToolsWithHeartbeat = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "child-ws",
        enableAgentReport: true,
        experiments: { workspaceHeartbeats: true },
        workspaceHeartbeatService: heartbeatService,
      },
      "child-ws",
      initStateManager
    );
    expect(childToolsWithHeartbeat.heartbeat).toBeUndefined();
    expect(toolsWithHeartbeat.heartbeat).toBeDefined();
  });

  test("only includes set_goal when goal service and setGoal gate are enabled", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();
    // Registration-only test; goal tools capture the service but never execute it here.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const goalService = {} as never;

    const disabled = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        goalService,
        enableGoalTools: { setGoal: false, getGoal: true, completeGoal: true },
      },
      "ws-1",
      initStateManager
    );
    expect(disabled.set_goal).toBeUndefined();
    expect(disabled.get_goal).toBeDefined();
    expect(disabled.complete_goal).toBeDefined();

    const enabled = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        goalService,
        enableGoalTools: { setGoal: true, getGoal: true, completeGoal: true },
      },
      "ws-1",
      initStateManager
    );
    expect(enabled.set_goal).toBeDefined();
  });

  test("withholds review_pane_* tools from sub-agents (enableAgentReport=true)", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    // Top-level workspace (not a sub-agent): Review pane tools available.
    const topLevelTools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        enableAgentReport: false,
      },
      "ws-1",
      initStateManager
    );
    expect(topLevelTools.review_pane_update).toBeDefined();
    expect(topLevelTools.review_pane_get).toBeDefined();

    // Sub-agent (child task workspace): can't pin code to the parent Review pane.
    const subAgentTools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        enableAgentReport: true,
      },
      "ws-1",
      initStateManager
    );
    expect(subAgentTools.review_pane_update).toBeUndefined();
    expect(subAgentTools.review_pane_get).toBeUndefined();
  });

  test("only includes workflow tools when dynamic workflows service and experiment are enabled", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const withoutExperiment = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        workflowService: {
          startWorkflow: mock(async () => ({
            runId: "wfr_1",
            status: "completed" as const,
            result: null,
          })),
        },
      },
      "ws-1",
      initStateManager
    );
    expect(withoutExperiment.workflow_list).toBeUndefined();
    expect(withoutExperiment.workflow_read).toBeUndefined();
    expect(withoutExperiment.workflow_run).toBeUndefined();
    expect(withoutExperiment.workflow_resume).toBeUndefined();

    const withExperiment = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        experiments: { dynamicWorkflows: true },
        workflowService: {
          startWorkflow: mock(async () => ({
            runId: "wfr_1",
            status: "completed" as const,
            result: null,
          })),
        },
      },
      "ws-1",
      initStateManager
    );
    expect(withExperiment.workflow_list).toBeUndefined();
    expect(withExperiment.workflow_read).toBeUndefined();
    expect(withExperiment.workflow_run).toBeDefined();
    expect(withExperiment.workflow_resume).toBeDefined();
  });

  test("includes desktop tools when workspace capability is available", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();
    const { desktopSessionManager, getCapability } = createDesktopSessionManager({
      available: true,
    });

    const tools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        desktopSessionManager,
      },
      "ws-1",
      initStateManager
    );

    expect(getCapability).toHaveBeenCalledWith("ws-1");
    for (const toolName of DESKTOP_TOOL_NAMES) {
      expect(tools[toolName]).toBeDefined();
    }
  });

  test("omits desktop tools when workspace capability is unavailable", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();
    const { desktopSessionManager, getCapability } = createDesktopSessionManager({
      available: false,
    });

    const tools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        desktopSessionManager,
      },
      "ws-1",
      initStateManager
    );

    expect(getCapability).toHaveBeenCalledWith("ws-1");
    expect(Object.keys(tools).filter((toolName) => toolName.startsWith("desktop_"))).toEqual([]);
  });

  test("omits desktop tools when no desktop manager is configured", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const tools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      initStateManager
    );

    expect(Object.keys(tools).filter((toolName) => toolName.startsWith("desktop_"))).toEqual([]);
  });

  test("adds native Google Search and URL Context only for Gemini 3 models", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const gemini25Tools = await getToolsForModel(
      "google:gemini-2.5-pro",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      initStateManager
    );
    expect(gemini25Tools.google_search).toBeUndefined();
    expect(gemini25Tools.url_context).toBeUndefined();

    const gemini4Tools = await getToolsForModel(
      "google:gemini-4-pro",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      initStateManager
    );
    expect(gemini4Tools.google_search).toBeUndefined();
    expect(gemini4Tools.url_context).toBeUndefined();

    const gemini35Tools = await getToolsForModel(
      "google:gemini-3.5-flash",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      initStateManager
    );
    const namespacedGemini35Tools = await getToolsForModel(
      "google:models/gemini-3.5-flash",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      initStateManager
    );
    expect(namespacedGemini35Tools.google_search).toBeDefined();
    expect(namespacedGemini35Tools.url_context).toBeDefined();

    expect(gemini35Tools.google_search).toBeDefined();
    expect(gemini35Tools.url_context).toBeDefined();
  });

  test("adds xAI native web and X search tools for Grok 4.5", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const tools = await getToolsForModel(
      "xai:grok-4.5",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        xaiSearchParameters: {
          mode: "auto",
          fromDate: "2026-07-01",
          sources: [
            { type: "web", allowedWebsites: ["example.com"] },
            { type: "x", includedXHandles: ["xai"] },
          ],
        },
      },
      "ws-1",
      initStateManager
    );

    expect(tools.web_search).toBeDefined();
    expect(tools.x_search).toBeDefined();
    expect(tools.web_search).toMatchObject({
      type: "provider",
      id: "xai.web_search",
      args: { allowedDomains: ["example.com"] },
    });
    expect(tools.x_search).toMatchObject({
      type: "provider",
      id: "xai.x_search",
      args: { allowedXHandles: ["xai"], fromDate: "2026-07-01" },
    });
  });

  test("omits xAI native search tools when the resolved route is not xAI Responses", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const tools = await getToolsForModel(
      "xai:grok-4.5",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        xaiNativeToolsEnabled: false,
      },
      "ws-1",
      initStateManager
    );

    expect(tools.web_search).toBeUndefined();
    expect(tools.x_search).toBeUndefined();
  });

  test("ignores malformed persisted xAI search sources instead of blocking requests", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();
    const malformedSearchParameters = {
      mode: "auto",
      sources: "not-an-array",
      fromDate: 123,
      toDate: "2026-99-99",
    } as unknown as ToolConfiguration["xaiSearchParameters"];

    const tools = await getToolsForModel(
      "xai:grok-4.5",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        xaiSearchParameters: malformedSearchParameters,
      },
      "ws-1",
      initStateManager
    );

    expect((tools.x_search as { args?: { fromDate?: string } }).args?.fromDate).toBeUndefined();
    expect((tools.x_search as { args?: { toDate?: string } }).args?.toDate).toBeUndefined();
    expect(tools.web_search).toBeDefined();
    expect(tools.x_search).toBeDefined();
  });

  test("adds xAI native search tools for Grok 4.5 aliases", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const tools = await getToolsForModel(
      "xai:grok-4.5-latest",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      initStateManager
    );

    expect(tools.web_search).toBeDefined();
    expect(tools.x_search).toBeDefined();
  });

  test("adds xAI native search tools for mapped Grok 4.5 aliases", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const tools = await getToolsForModel(
      "xai:team-grok",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        capabilityModelString: "xai:grok-4.5",
      },
      "ws-1",
      initStateManager
    );

    expect(tools.web_search).toBeDefined();
    expect(tools.x_search).toBeDefined();
  });

  test("merges every configured xAI web, news, and X source entry", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const tools = await getToolsForModel(
      "xai:grok-4.5",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        xaiSearchParameters: {
          mode: "auto",
          sources: [
            { type: "web", allowedWebsites: ["one.example"], excludedWebsites: ["bad.one"] },
            { type: "web", allowedWebsites: ["two.example"], excludedWebsites: ["bad.two"] },
            { type: "news", excludedWebsites: ["bad.news"] },
            { type: "x", includedXHandles: ["xai"], excludedXHandles: ["spam_one"] },
            { type: "x", xHandles: ["grok"], excludedXHandles: ["spam_two"] },
          ],
        },
      },
      "ws-1",
      initStateManager
    );

    expect(tools.web_search).toMatchObject({
      args: {
        allowedDomains: ["one.example", "two.example"],
      },
    });
    expect(
      (tools.web_search as { args?: { excludedDomains?: string[] } }).args?.excludedDomains
    ).toBeUndefined();
    expect(tools.x_search).toMatchObject({
      args: {
        allowedXHandles: ["xai", "grok"],
      },
    });
    expect(
      (tools.x_search as { args?: { excludedXHandles?: string[] } }).args?.excludedXHandles
    ).toBeUndefined();
  });

  test("merges exclusion-only xAI source entries without mutually exclusive allowlists", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const tools = await getToolsForModel(
      "xai:grok-4.5",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        xaiSearchParameters: {
          mode: "auto",
          sources: [
            { type: "web", excludedWebsites: ["bad.one"] },
            { type: "news", excludedWebsites: ["bad.news"] },
            { type: "x", excludedXHandles: ["spam_one"] },
            { type: "x", excludedXHandles: ["spam_two"] },
          ],
        },
      },
      "ws-1",
      initStateManager
    );

    expect(tools.web_search).toMatchObject({
      args: { excludedDomains: ["bad.one", "bad.news"] },
    });
    expect(tools.x_search).toMatchObject({
      args: { excludedXHandles: ["spam_one", "spam_two"] },
    });
  });

  test("preserves RSS-only xAI search configs as domain-scoped web search", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const tools = await getToolsForModel(
      "xai:grok-4.5",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        xaiSearchParameters: {
          mode: "auto",
          sources: [
            {
              type: "rss",
              links: [
                "https://feeds.example.com/news.xml",
                "https://updates.example.org/releases.xml",
              ],
            },
          ],
        },
      },
      "ws-1",
      initStateManager
    );

    expect(tools.web_search).toMatchObject({
      type: "provider",
      id: "xai.web_search",
      args: { allowedDomains: ["feeds.example.com", "updates.example.org"] },
    });
    expect(tools.x_search).toBeUndefined();
  });

  test("marks mode:on xAI search tools as required on the first model step", () => {
    expect(
      getForcedXaiSearchToolNames("xai:grok-4.5", {
        mode: "on",
        sources: [{ type: "x", includedXHandles: ["xai"] }],
      })
    ).toEqual(["x_search"]);
    expect(getForcedXaiSearchToolNames("xai:grok-4.5", { mode: "auto" })).toBeUndefined();
    expect(getForcedXaiSearchToolNames("xai:grok-4-1-fast", { mode: "on" })).toBeUndefined();
  });

  test("honors disabled xAI search mode for Grok 4.5", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const tools = await getToolsForModel(
      "xai:grok-4.5",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
        xaiSearchParameters: { mode: "off" },
      },
      "ws-1",
      initStateManager
    );

    expect(tools.web_search).toBeUndefined();
    expect(tools.x_search).toBeUndefined();
  });

  test("returns tool keys in sorted order", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = createInitStateManager();

    const tools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      initStateManager,
      undefined,
      {
        zeta_tool: {
          description: "zeta",
          inputSchema: z.object({}),
          execute: mock(() => Promise.resolve({})),
        },
        alpha_tool: {
          description: "alpha",
          inputSchema: z.object({}),
          execute: mock(() => Promise.resolve({})),
        },
      }
    );

    const toolNames = Object.keys(tools);
    expect(toolNames).toEqual([...toolNames].sort((a, b) => a.localeCompare(b)));
  });

  test("includes web_fetch in the runtime toolset", async () => {
    const tools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime: new LocalRuntime(process.cwd()),
        runtimeTempDir: "/tmp",
        workspaceId: "ws-1",
      },
      "ws-1",
      createInitStateManager()
    );

    expect(tools.web_fetch).toBeDefined();
  });
});
