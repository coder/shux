import { describe, expect, it } from "bun:test";
import type { ProjectsConfig } from "@/common/types/project";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { DEFAULT_LAYOUT_PRESETS_CONFIG } from "@/common/types/uiLayouts";
import { DEFAULT_GOAL_DEFAULTS } from "@/constants/goals";
import {
  mergeBackupSettings,
  projectBackupSettings,
  readBackupSettings,
} from "./settingsProjection";

describe("settingsProjection", () => {
  it("projects portable settings and leaves machine-local keys behind", () => {
    const portable = {
      agentAiDefaults: {
        exec: {
          modelString: "anthropic:claude-exec",
          thinkingLevel: "high",
          subagent: { modelString: "openai:gpt-sub", thinkingLevel: "low" },
        },
        plan: { modelString: "openai:gpt-plan", reasoningMode: "pro", advisorEnabled: true },
        review: { enabled: false },
      },
      defaultModel: "anthropic:claude-exec",
      hiddenModels: ["openai:gpt-old"],
      minThinkingLevelByModel: { "openai:gpt-plan": "medium" },
      modelFallbacks: { "anthropic:claude-exec": { models: ["openai:gpt-plan"] } },
      advisorModelString: "openai:gpt-advisor",
      advisorThinkingLevel: "xhigh",
      advisorReasoningMode: "pro",
      advisorMaxUsesPerTurn: 3,
      advisorMaxOutputTokens: null,
      taskSettings: {
        maxParallelAgentTasks: 4,
        maxTaskNestingDepth: 2,
        preserveSubagentsUntilArchive: true,
      },
      heartbeatDefaultPrompt: "Check in",
      heartbeatDefaultIntervalMs: 15 * 60 * 1000,
      goalDefaults: {
        defaultBudgetCents: 500,
        defaultTurnCap: 20,
        alwaysRequireExplicitBudget: false,
      },
      chatTranscriptFullWidth: true,
      llmDebugLogs: false,
      coderWorkspaceArchiveBehavior: "delete",
      worktreeArchiveBehavior: "snapshot",
      runtimeEnablement: { docker: false },
      defaultRuntime: "worktree",
    } satisfies Partial<ProjectsConfig>;
    const config: ProjectsConfig = {
      projects: new Map([["/repo", { workspaces: [] }]]),
      ...portable,
      apiServerPort: 4321,
      apiServerBindHost: "0.0.0.0",
      terminalDefaultShell: "/bin/fish",
      updateChannel: "nightly",
      muxGovernorUrl: "https://governor.example.com",
      muxGovernorToken: "governor-secret",
      routePriority: ["anthropic"],
      routeOverrides: { "anthropic:claude-exec": "direct" },
      viewedSplashScreens: ["welcome"],
      migrations: { hiddenModelsInitialized: true },
      settingsBackup: { repoUrl: "https://example.com/backup.git", branch: "main", path: "xum" },
    };

    const projected = projectBackupSettings(config);

    expect(projected).toEqual(portable);
    expect(JSON.stringify(projected)).not.toContain("governor-secret");
    // A copy, not a view: editing the projection must not reach the live config.
    expect(projected.agentAiDefaults).not.toBe(config.agentAiDefaults);
  });

  it("keeps an empty hidden list but drops empty agent defaults and layouts", () => {
    const projected = projectBackupSettings({
      projects: new Map(),
      hiddenModels: [],
      agentAiDefaults: {},
      layoutPresets: DEFAULT_LAYOUT_PRESETS_CONFIG,
      chatTranscriptFullWidth: false,
    });
    // goalDefaults always resolves to the effective value, as the config load does.
    expect(projected).toEqual({ hiddenModels: [], goalDefaults: DEFAULT_GOAL_DEFAULTS });
  });

  it("replaces backed-up keys wholesale and keeps the rest of the local config", () => {
    const current: ProjectsConfig = {
      projects: new Map(),
      agentAiDefaults: { exec: { modelString: "openai:gpt-local" }, review: { enabled: false } },
      defaultModel: "openai:gpt-local",
      hiddenModels: ["openai:gpt-hidden-locally"],
      apiServerPort: 4321,
      terminalDefaultShell: "/bin/fish",
      migrations: { daybreakModelsHidden: true },
    };

    const merged = mergeBackupSettings(current, {
      agentAiDefaults: { plan: { modelString: "anthropic:claude-plan" } },
      hiddenModels: [],
      taskSettings: { maxParallelAgentTasks: 2 },
      layoutPresets: { version: 2, slots: [] },
    });

    expect(merged.agentAiDefaults).toEqual({ plan: { modelString: "anthropic:claude-plan" } });
    expect(merged.hiddenModels).toEqual([]);
    expect(merged.defaultModel).toBe("openai:gpt-local");
    expect(merged.apiServerPort).toBe(4321);
    expect(merged.terminalDefaultShell).toBe("/bin/fish");
    expect(merged.taskSettings).toEqual({ ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 2 });
    expect(merged.layoutPresets).toEqual(DEFAULT_LAYOUT_PRESETS_CONFIG);
    expect(merged.migrations).toEqual({
      daybreakModelsHidden: true,
      hiddenModelsInitialized: true,
    });
    expect(current.agentAiDefaults?.exec).toBeDefined();
  });

  it("does not touch the hidden-model migration when the backup carries no list", () => {
    const merged = mergeBackupSettings(
      { projects: new Map(), migrations: { daybreakModelsHidden: true } },
      { defaultModel: "anthropic:claude-plan" }
    );
    expect(merged.migrations).toEqual({ daybreakModelsHidden: true });
  });

  it("reads only the portable settings block and rejects a malformed one", () => {
    expect(readBackupSettings({ appearance: { theme: "dark" } })).toBeUndefined();
    expect(readBackupSettings(undefined)).toBeUndefined();

    expect(
      readBackupSettings({
        settings: {
          defaultModel: "anthropic:claude-plan",
          apiServerPort: 4321,
          muxGovernorToken: "smuggled",
          unknownKey: true,
        },
      })
    ).toEqual({ defaultModel: "anthropic:claude-plan" });

    // The error names the field so the Backup screen can say what is wrong with the document.
    expect(() =>
      readBackupSettings({ settings: { agentAiDefaults: { exec: { thinkingLevel: "bogus" } } } })
    ).toThrow(/settings block \(agentAiDefaults\.exec\.thinkingLevel: /);
    expect(() => readBackupSettings({ settings: { heartbeatDefaultIntervalMs: 1 } })).toThrow(
      /heartbeatDefaultIntervalMs/
    );
    expect(() => readBackupSettings({ settings: null })).toThrow();
  });
});
