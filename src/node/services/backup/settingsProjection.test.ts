import { describe, expect, it } from "bun:test";
import type { ProjectsConfig } from "@/common/types/project";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { DEFAULT_LAYOUT_PRESETS_CONFIG } from "@/common/types/uiLayouts";
import { DEFAULT_GOAL_DEFAULTS } from "@/constants/goals";
import { ADVISOR_DEFAULT_MAX_USES_PER_TURN } from "@/common/constants/advisor";
import {
  mergeBackupSettings,
  projectBackupSettings,
  readBackupSettings,
} from "./settingsProjection";

/** What a config with none of the portable settings set exports: every key, spelled unset. */
const UNSET_EXPORT = {
  agentAiDefaults: {},
  defaultModel: null,
  hiddenModels: null,
  minThinkingLevelByModel: null,
  modelFallbacks: null,
  advisorModelString: null,
  advisorThinkingLevel: null,
  advisorReasoningMode: null,
  // null would mean "unlimited" to the advisor, so the default cap stands in for unset.
  advisorMaxUsesPerTurn: ADVISOR_DEFAULT_MAX_USES_PER_TURN,
  advisorMaxOutputTokens: null,
  taskSettings: DEFAULT_TASK_SETTINGS,
  heartbeatDefaultPrompt: null,
  heartbeatDefaultIntervalMs: null,
  goalDefaults: DEFAULT_GOAL_DEFAULTS,
  chatTranscriptFullWidth: false,
  llmDebugLogs: false,
  runtimeEnablement: null,
  defaultRuntime: null,
  layoutPresets: null,
};

describe("settingsProjection", () => {
  it("projects every portable setting and leaves machine-local keys behind", () => {
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
        ...DEFAULT_TASK_SETTINGS,
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
      runtimeEnablement: { docker: false },
      defaultRuntime: "worktree",
    } satisfies Partial<ProjectsConfig>;
    const config: ProjectsConfig = {
      projects: new Map([["/repo", { workspaces: [] }]]),
      ...portable,
      apiServerPort: 4321,
      apiServerBindHost: "0.0.0.0",
      worktreeArchiveBehavior: "delete",
      coderWorkspaceArchiveBehavior: "delete",
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

    expect(projected).toEqual({ ...portable, layoutPresets: null });
    expect(JSON.stringify(projected)).not.toContain("governor-secret");
    // A copy, not a view: editing the projection must not reach the live config.
    expect(projected.agentAiDefaults).not.toBe(config.agentAiDefaults);
  });

  it("exports resets as explicit unset values, the same for a fresh and a saved config", () => {
    // A fresh install holds none of these keys; a loaded config holds their normalized forms.
    // Both must export identically or the first push after a save would look like a change.
    expect(projectBackupSettings({ projects: new Map() })).toEqual(UNSET_EXPORT);
    expect(
      projectBackupSettings({
        projects: new Map(),
        agentAiDefaults: {},
        hiddenModels: undefined,
        layoutPresets: DEFAULT_LAYOUT_PRESETS_CONFIG,
        chatTranscriptFullWidth: undefined,
        taskSettings: DEFAULT_TASK_SETTINGS,
        goalDefaults: DEFAULT_GOAL_DEFAULTS,
      })
    ).toEqual(UNSET_EXPORT);
    // An emptied hidden list is a choice, not an unset value.
    expect(projectBackupSettings({ projects: new Map(), hiddenModels: [] }).hiddenModels).toEqual(
      []
    );
  });

  it("restoring a reset source clears the target's overrides", () => {
    const target: ProjectsConfig = {
      projects: new Map(),
      agentAiDefaults: { exec: { modelString: "openai:gpt-local" } },
      modelFallbacks: { "openai:gpt-local": { models: ["anthropic:claude-exec"] } },
      advisorModelString: "openai:gpt-advisor",
      advisorMaxUsesPerTurn: 2,
      chatTranscriptFullWidth: true,
      defaultRuntime: "docker",
      layoutPresets: { version: 2, slots: [{ slot: 1 }] },
      apiServerPort: 4321,
    };

    const merged = mergeBackupSettings(
      target,
      readBackupSettings({ settings: projectBackupSettings({ projects: new Map() }) }).settings!
    );

    expect(merged.agentAiDefaults).toEqual({});
    expect(merged.modelFallbacks).toBeUndefined();
    expect(merged.advisorModelString).toBeUndefined();
    expect(merged.advisorMaxUsesPerTurn).toBe(ADVISOR_DEFAULT_MAX_USES_PER_TURN);
    expect(merged.chatTranscriptFullWidth).toBe(false);
    expect(merged.defaultRuntime).toBeUndefined();
    expect(merged.layoutPresets).toBeUndefined();
    expect(merged.apiServerPort).toBe(4321);
    // The round trip closes: the restored target exports what the source exported.
    expect(projectBackupSettings(merged)).toEqual(UNSET_EXPORT);
  });

  it("keeps the advisor's unlimited cap distinct from its default", () => {
    // A source at the default cap must not restore as unlimited, and unlimited must survive.
    const unlimited = projectBackupSettings({ projects: new Map(), advisorMaxUsesPerTurn: null });
    expect(unlimited.advisorMaxUsesPerTurn).toBeNull();
    const target: ProjectsConfig = { projects: new Map(), advisorMaxUsesPerTurn: null };
    const fromDefault = readBackupSettings({
      settings: projectBackupSettings({ projects: new Map() }),
    }).settings!;
    expect(mergeBackupSettings(target, fromDefault).advisorMaxUsesPerTurn).toBe(
      ADVISOR_DEFAULT_MAX_USES_PER_TURN
    );
    const fromUnlimited = readBackupSettings({ settings: unlimited }).settings!;
    expect(
      mergeBackupSettings({ projects: new Map(), advisorMaxUsesPerTurn: 5 }, fromUnlimited)
        .advisorMaxUsesPerTurn
    ).toBeNull();
  });

  it("replaces the keys a sparse block carries and keeps the rest of the local config", () => {
    const current: ProjectsConfig = {
      projects: new Map(),
      agentAiDefaults: { exec: { modelString: "openai:gpt-local" }, review: { enabled: false } },
      defaultModel: "openai:gpt-local",
      hiddenModels: ["openai:gpt-hidden-locally"],
      apiServerPort: 4321,
      terminalDefaultShell: "/bin/fish",
      migrations: { daybreakModelsHidden: true },
    };

    // A block an older build wrote, with only some of the keys.
    const sparse = readBackupSettings({
      settings: {
        agentAiDefaults: { plan: { modelString: "anthropic:claude-plan" } },
        hiddenModels: [],
        taskSettings: { maxParallelAgentTasks: 2 },
        layoutPresets: { version: 2, slots: [] },
      },
    }).settings!;
    const merged = mergeBackupSettings(current, sparse);

    expect(merged.agentAiDefaults).toEqual({ plan: { modelString: "anthropic:claude-plan" } });
    expect(merged.hiddenModels).toEqual([]);
    expect(merged.defaultModel).toBe("openai:gpt-local");
    expect(merged.apiServerPort).toBe(4321);
    expect(merged.terminalDefaultShell).toBe("/bin/fish");
    expect(merged.taskSettings).toEqual({ ...DEFAULT_TASK_SETTINGS, maxParallelAgentTasks: 2 });
    expect(merged.layoutPresets).toBeUndefined();
    expect(merged.migrations).toEqual({
      daybreakModelsHidden: true,
      hiddenModelsInitialized: true,
    });
    expect(current.agentAiDefaults?.exec).toBeDefined();
  });

  it("does not touch the hidden-model migration when the backup carries no list", () => {
    const merged = mergeBackupSettings(
      { projects: new Map(), migrations: { daybreakModelsHidden: true } },
      { defaultModel: "anthropic:claude-plan", hiddenModels: null }
    );
    expect(merged.migrations).toEqual({ daybreakModelsHidden: true });
    expect(merged.hiddenModels).toBeUndefined();
  });

  it("canonicalizes accepted values the way config.json persists them", () => {
    // A schema-valid document can still hold spellings the save path would rewrite; reading
    // them canonically is what makes the post-write comparison hold.
    const { settings } = readBackupSettings({
      settings: {
        defaultModel: " anthropic:claude-exec ",
        hiddenModels: ["openai:gpt-a", "openai:gpt-a", " "],
        modelFallbacks: {
          "anthropic:claude-exec": { models: ["anthropic:claude-exec", "openai:gpt-plan"] },
        },
        heartbeatDefaultPrompt: "  Check in  ",
        agentAiDefaults: { exec: { modelString: " openai:gpt-exec " } },
      },
    });

    expect(settings).toMatchObject({
      defaultModel: "anthropic:claude-exec",
      hiddenModels: ["openai:gpt-a"],
      modelFallbacks: { "anthropic:claude-exec": { models: ["openai:gpt-plan"] } },
      heartbeatDefaultPrompt: "Check in",
      agentAiDefaults: { exec: { modelString: "openai:gpt-exec" } },
    });
  });

  it("reads only the portable settings block", () => {
    const none = { settings: undefined, unsupported: [] };
    expect(readBackupSettings({ appearance: { theme: "dark" } })).toEqual(none);
    expect(readBackupSettings(undefined)).toEqual(none);

    expect(
      readBackupSettings({
        settings: {
          defaultModel: "anthropic:claude-plan",
          apiServerPort: 4321,
          muxGovernorToken: "smuggled",
          unknownKey: true,
        },
      })
    ).toEqual({ settings: { defaultModel: "anthropic:claude-plan" }, unsupported: [] });
  });

  it("keeps the local value for fields this build does not understand and names them", () => {
    // A newer build's export (or a damaged document): the other fields still apply, and the
    // restore reports the skipped ones instead of refusing the whole backup on a downgrade.
    const read = readBackupSettings({
      settings: {
        agentAiDefaults: { exec: { thinkingLevel: "bogus" } },
        heartbeatDefaultIntervalMs: 1,
        // The on-disk schema leaves this key unknown; a version this build cannot migrate would
        // otherwise normalize to empty and delete the target's presets.
        layoutPresets: { version: 3, slots: [{ slot: 1 }] },
        defaultModel: "anthropic:claude-plan",
      },
    });
    expect(read.unsupported).toEqual([
      "agentAiDefaults",
      "heartbeatDefaultIntervalMs",
      "layoutPresets",
    ]);
    expect(read.settings).toEqual({ defaultModel: "anthropic:claude-plan" });
    for (const layoutPresets of ["garbage", { version: 2, slots: "corrupt" }]) {
      expect(readBackupSettings({ settings: { layoutPresets } }).unsupported).toEqual([
        "layoutPresets",
      ]);
    }

    const current: ProjectsConfig = {
      projects: new Map(),
      agentAiDefaults: { exec: { modelString: "openai:gpt-local" } },
      heartbeatDefaultIntervalMs: 900_000,
      layoutPresets: { version: 2, slots: [{ slot: 1 }] },
    };
    const merged = mergeBackupSettings(current, read.settings!);
    expect(merged.agentAiDefaults).toEqual(current.agentAiDefaults);
    expect(merged.heartbeatDefaultIntervalMs).toBe(900_000);
    expect(merged.layoutPresets).toEqual(current.layoutPresets);
    expect(merged.defaultModel).toBe("anthropic:claude-plan");

    expect(readBackupSettings({ settings: null })).toEqual({
      settings: undefined,
      unsupported: ["settings (not an object)"],
    });
  });
});
