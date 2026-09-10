import { describe, it, expect } from "bun:test";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { getSlashCommandSuggestions } from "./suggestions";
import { resolveSlashCommandExperimentValue } from "./experimentVisibility";

describe("resolveSlashCommandExperimentValue", () => {
  it("requires the parent memory experiment for memory-consolidation", () => {
    // The backend rejects /dream unless BOTH flags are on, so the sub-flag
    // alone must not surface the command.
    expect(
      resolveSlashCommandExperimentValue(EXPERIMENT_IDS.MEMORY_CONSOLIDATION, {
        workspaceHeartbeats: false,
        memoryConsolidation: true,
      })
    ).toBe(false);
    expect(
      resolveSlashCommandExperimentValue(EXPERIMENT_IDS.MEMORY_CONSOLIDATION, {
        workspaceHeartbeats: false,
        memory: true,
        memoryConsolidation: true,
      })
    ).toBe(true);
  });

  it("requires the PTC parent flag for rlm-mode", () => {
    // The backend refuses /refine unless RLM AND PTC are on, so the
    // sub-flag alone must not surface the command.
    expect(
      resolveSlashCommandExperimentValue(EXPERIMENT_IDS.RLM, {
        workspaceHeartbeats: false,
        rlm: true,
      })
    ).toBe(false);
    expect(
      resolveSlashCommandExperimentValue(EXPERIMENT_IDS.RLM, {
        workspaceHeartbeats: false,
        rlm: true,
        programmaticToolCalling: true,
      })
    ).toBe(true);
  });
});

describe("getSlashCommandSuggestions", () => {
  it("returns empty suggestions for non-commands", () => {
    expect(getSlashCommandSuggestions("hello")).toEqual([]);
    expect(getSlashCommandSuggestions("")).toEqual([]);
  });

  it("filters workspace-only commands in creation mode", () => {
    const suggestions = getSlashCommandSuggestions("/", { variant: "creation" });
    const labels = suggestions.map((s) => s.display);

    expect(labels).not.toContain("/clear");
    expect(labels).not.toContain("/plan");
  });

  it("omits workspace-only subcommands in creation mode", () => {
    const suggestions = getSlashCommandSuggestions("/plan ", { variant: "creation" });
    expect(suggestions).toEqual([]);
  });
  it("hides experiment-gated commands when their experiments are disabled", () => {
    const suggestions = getSlashCommandSuggestions("/", {
      isExperimentEnabled: () => false,
    });
    const labels = suggestions.map((s) => s.display);

    expect(labels).not.toContain("/heartbeat");
    expect(labels).not.toContain("/dream");
    expect(labels).not.toContain("/refine");
    // `/goal` graduated to GA — it must surface regardless of experiment state.
    expect(labels).toContain("/goal");
  });

  it("shows experiment-gated commands when their experiments are enabled", () => {
    const enabledExperiments = new Set<ExperimentId>([
      EXPERIMENT_IDS.WORKSPACE_HEARTBEATS,
      EXPERIMENT_IDS.MEMORY_CONSOLIDATION,
      EXPERIMENT_IDS.RLM,
    ]);
    const suggestions = getSlashCommandSuggestions("/", {
      isExperimentEnabled: (experimentId) => enabledExperiments.has(experimentId),
    });
    const labels = suggestions.map((s) => s.display);

    expect(labels).toContain("/heartbeat");
    expect(labels).toContain("/dream");
    expect(labels).toContain("/refine");
    // `/goal` is always available post-GA.
    expect(labels).toContain("/goal");
  });

  it("suggests top level commands when starting with slash", () => {
    const suggestions = getSlashCommandSuggestions("/");
    const labels = suggestions.map((s) => s.display);

    expect(labels).toContain("/clear");
    expect(labels).toContain("/model");
  });

  it("includes agent skills when provided in context", () => {
    const suggestions = getSlashCommandSuggestions("/", {
      agentSkills: [
        {
          name: "test-skill",
          description: "Test skill description",
          scope: "project",
        },
      ],
    });

    const skillSuggestion = suggestions.find((s) => s.display === "/test-skill");
    expect(skillSuggestion).toBeTruthy();
    expect(skillSuggestion?.replacement).toBe("/test-skill ");
    expect(skillSuggestion?.description).toContain("(project)");
  });

  it("includes MCP prompts with positional argument hints", () => {
    const suggestions = getSlashCommandSuggestions("/mcp__coder", {
      mcpPrompts: [
        {
          commandKey: "mcp__coder__review",
          stableKey: "mcp__coder__review_11111111",
          serverName: "coder",
          promptName: "review",
          description: "Review code",
          arguments: [
            { name: "path", required: true },
            { name: "focus", required: false },
          ],
        },
      ],
    });

    expect(suggestions).toContainEqual({
      id: "mcp-prompt:mcp__coder__review",
      display: "/mcp__coder__review [path] [focus?]",
      description: "Review code (coder)",
      replacement: "/mcp__coder__review ",
    });
  });

  it("hides user-invocable: false skills from slash suggestions", () => {
    const suggestions = getSlashCommandSuggestions("/", {
      agentSkills: [
        {
          name: "visible-skill",
          description: "Visible",
          scope: "project",
        },
        {
          name: "model-only-skill",
          description: "Hidden from user-facing surfaces",
          scope: "project",
          userInvocable: false,
        },
      ],
    });

    const labels = suggestions.map((s) => s.display);
    expect(labels).toContain("/visible-skill");
    expect(labels).not.toContain("/model-only-skill");
  });

  it("shows argument-hint next to the skill name without affecting matching or replacement", () => {
    const suggestions = getSlashCommandSuggestions("/fix", {
      agentSkills: [
        {
          name: "fix-issue",
          description: "Fix a GitHub issue",
          scope: "project",
          argumentHint: "[issue-number]",
        },
      ],
    });

    const skillSuggestion = suggestions.find((s) => s.id === "skill:fix-issue");
    expect(skillSuggestion?.display).toBe("/fix-issue [issue-number]");
    // Hint is display-only: inserting the suggestion must not paste the hint.
    expect(skillSuggestion?.replacement).toBe("/fix-issue ");
  });

  it("matches hyphenated skill segments", () => {
    const suggestions = getSlashCommandSuggestions("/r", {
      agentSkills: [
        {
          name: "deep-review",
          description: "Test",
          scope: "project",
        },
      ],
    });

    const labels = suggestions.map((s) => s.display);
    expect(labels).toContain("/deep-review");
  });

  it("matches full prefixes that cross hyphen boundaries", () => {
    const suggestions = getSlashCommandSuggestions("/deep-r", {
      agentSkills: [
        {
          name: "deep-review",
          description: "Test",
          scope: "project",
        },
      ],
    });

    expect(suggestions.map((s) => s.display)).toContain("/deep-review");
  });

  it("filters top level commands by partial input", () => {
    const suggestions = getSlashCommandSuggestions("/cl");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].replacement).toBe("/clear");
  });

  it("suggests model abbreviations after /model", () => {
    const suggestions = getSlashCommandSuggestions("/model ");
    const displays = suggestions.map((s) => s.display);

    expect(displays).toContain("opus");
    expect(displays).toContain("sonnet");
  });

  it("filters model suggestions by partial input", () => {
    const suggestions = getSlashCommandSuggestions("/model op");
    // Only "opus" (opus-4-6) matches the "op" prefix
    expect(suggestions).toHaveLength(1);
    const displays = suggestions.map((s) => s.display);
    expect(displays).toContain("opus");
  });

  it("suggests model aliases as one-shot commands", () => {
    const suggestions = getSlashCommandSuggestions("/");
    const displays = suggestions.map((s) => s.display);

    expect(displays).toContain("/haiku");
    expect(displays).toContain("/sonnet");
    expect(displays).toContain("/opus");
  });

  it("filters model alias suggestions by partial input", () => {
    const suggestions = getSlashCommandSuggestions("/ha");
    const displays = suggestions.map((s) => s.display);

    expect(displays).toContain("/haiku");
    expect(displays).not.toContain("/sonnet");
  });

  it("includes usable metadata for model alias suggestions", () => {
    const suggestions = getSlashCommandSuggestions("/haiku");
    const haiku = suggestions.find((s) => s.display === "/haiku");

    expect(haiku).toBeTruthy();
    expect(haiku?.description).toBeTruthy();
    expect(haiku?.replacement).toBe("/haiku ");
  });

  describe("plugin-contributed commands", () => {
    const pluginCommands = [
      {
        name: "greet",
        description: "Say hello",
        expansion: "Please greet the user warmly.",
        pluginName: "my-plugin",
        scope: "global" as const,
      },
    ];

    it("merges plugin commands as data-driven entries whose replacement is the expansion", () => {
      const suggestions = getSlashCommandSuggestions("/gre", { pluginCommands });
      const greet = suggestions.find((s) => s.id === "plugin-command:greet");

      expect(greet).toBeTruthy();
      expect(greet?.display).toBe("/greet");
      expect(greet?.description).toBe("Say hello (plugin:my-plugin)");
      expect(greet?.replacement).toBe("Please greet the user warmly.");
    });

    it("filters plugin commands by partial input", () => {
      const suggestions = getSlashCommandSuggestions("/xyz", { pluginCommands });
      expect(suggestions.find((s) => s.id === "plugin-command:greet")).toBeUndefined();
    });

    it("built-in commands and skills take precedence over plugin commands on collision", () => {
      const colliding = [
        { ...pluginCommands[0], name: "compact" },
        { ...pluginCommands[0], name: "my-skill" },
      ];
      const suggestions = getSlashCommandSuggestions("/", {
        pluginCommands: colliding,
        agentSkills: [{ name: "my-skill", description: "A skill", scope: "project" }],
      });

      expect(suggestions.find((s) => s.id === "plugin-command:compact")).toBeUndefined();
      expect(suggestions.find((s) => s.id === "plugin-command:my-skill")).toBeUndefined();
      // The colliding names still resolve through their canonical providers.
      expect(suggestions.find((s) => s.id === "command:compact")).toBeTruthy();
      expect(suggestions.find((s) => s.id === "skill:my-skill")).toBeTruthy();
    });
  });
});
