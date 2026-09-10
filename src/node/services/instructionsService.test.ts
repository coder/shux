import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { InstructionsService } from "./instructionsService";
import { Config } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { TokenizerService } from "@/node/services/tokenizerService";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

// Regression coverage for token counting in the Instructions tab: model
// selection is persisted per-agent (aiSettingsByAgent), so resolution must not
// stop at the legacy workspace-scoped aiSettings field.
describe("InstructionsService model resolution", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "instructions-service-test-"));
    projectDir = path.join(tempDir, "project");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "AGENTS.md"), "Some instructions.\n");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createService(
    metadata: WorkspaceMetadata,
    countedModels: string[],
    claudeSkillsCompatEnabled = false
  ) {
    const aiService = {
      getWorkspaceMetadata: () => Promise.resolve({ success: true, data: metadata }),
      isClaudeSkillsCompatEnabled: () => claudeSkillsCompatEnabled,
    } as unknown as AIService;
    const tokenizerService = {
      countTokens: (model: string, content: string) => {
        countedModels.push(model);
        return Promise.resolve(content.length);
      },
    } as unknown as TokenizerService;
    return new InstructionsService(new Config(tempDir), aiService, tokenizerService);
  }

  function baseMetadata(): WorkspaceMetadata {
    // projectPath === name selects the in-place workspace path shape, so the
    // service reads AGENTS.md straight from projectDir without a worktree.
    return {
      id: "ws-1",
      name: projectDir,
      projectName: "project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };
  }

  test("resolves model from the selected agent's aiSettingsByAgent entry", async () => {
    const counted: string[] = [];
    const service = createService(
      {
        ...baseMetadata(),
        agentId: "plan",
        aiSettingsByAgent: {
          plan: { model: "anthropic:plan-model", thinkingLevel: "off" as const },
          [WORKSPACE_DEFAULTS.agentId]: {
            model: "anthropic:exec-model",
            thinkingLevel: "off" as const,
          },
        },
        aiSettings: { model: "anthropic:legacy-model", thinkingLevel: "off" as const },
      },
      counted
    );

    const result = await service.getWorkspaceInstructions("ws-1");
    expect(result.model).toBe("anthropic:plan-model");
    expect(counted.length).toBeGreaterThan(0);
    expect(new Set(counted)).toEqual(new Set(["anthropic:plan-model"]));
    expect(result.totalTokens).not.toBeNull();
  });

  test("falls back to the default agent's settings, then legacy aiSettings", async () => {
    const counted: string[] = [];
    const service = createService(
      {
        ...baseMetadata(),
        agentId: "plan",
        aiSettingsByAgent: {
          [WORKSPACE_DEFAULTS.agentId]: {
            model: "anthropic:exec-model",
            thinkingLevel: "off" as const,
          },
        },
      },
      counted
    );
    const result = await service.getWorkspaceInstructions("ws-1");
    expect(result.model).toBe("anthropic:exec-model");

    const legacyOnly = createService(
      {
        ...baseMetadata(),
        aiSettings: { model: "anthropic:legacy-model", thinkingLevel: "off" as const },
      },
      []
    );
    const legacyResult = await legacyOnly.getWorkspaceInstructions("ws-1");
    expect(legacyResult.model).toBe("anthropic:legacy-model");
  });

  test("includes Claude compatibility instructions in the panel payload with token counts", async () => {
    const originalMuxRoot = process.env.MUX_ROOT;
    const mockHomedir = spyOn(os, "homedir").mockReturnValue(tempDir);
    const claudeDir = path.join(tempDir, ".claude");
    const nativeGlobalDir = path.join(tempDir, ".xum");
    await fs.mkdir(claudeDir);
    await fs.mkdir(nativeGlobalDir);
    await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "Claude panel guidance.");
    process.env.MUX_ROOT = nativeGlobalDir;

    try {
      const counted: string[] = [];
      const service = createService(
        {
          ...baseMetadata(),
          aiSettings: { model: "anthropic:test-model", thinkingLevel: "off" },
        },
        counted,
        true
      );

      const result = await service.getWorkspaceInstructions("ws-1");
      const claudeFile = result.sources.global[0]?.files[0];

      expect(claudeFile?.path).toBe(path.join(claudeDir, "CLAUDE.md"));
      expect(claudeFile?.xumOnly).toBe(false);
      expect(claudeFile?.tokens).toBe("Claude panel guidance.".length);
      expect(result.files[0]?.path).toBe(claudeFile?.path);
      expect(result.totalTokens).not.toBeNull();
      expect(new Set(counted)).toEqual(new Set(["anthropic:test-model"]));
    } finally {
      mockHomedir.mockRestore();
      if (originalMuxRoot === undefined) {
        delete process.env.MUX_ROOT;
      } else {
        process.env.MUX_ROOT = originalMuxRoot;
      }
    }
  });

  test("explicit model override wins over persisted settings", async () => {
    const counted: string[] = [];
    const service = createService(
      {
        ...baseMetadata(),
        aiSettingsByAgent: {
          [WORKSPACE_DEFAULTS.agentId]: {
            model: "anthropic:exec-model",
            thinkingLevel: "off" as const,
          },
        },
      },
      counted
    );
    const result = await service.getWorkspaceInstructions("ws-1", "openai:override-model");
    expect(result.model).toBe("openai:override-model");
    expect(new Set(counted)).toEqual(new Set(["openai:override-model"]));
  });
});
