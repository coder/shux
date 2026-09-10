import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { buildSystemMessage, extractToolInstructions, readToolInstructions } from "./systemMessage";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig } from "@/common/types/project";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

const extractTagContent = (message: string, tagName: string): string | null => {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i");
  const match = pattern.exec(message);
  return match ? match[1].trim() : null;
};
import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";

// Note: in this file we avoid tests that are merely tautological assertions of constants. Only
// tests that verify branching logic should be here.

describe("extractToolInstructions", () => {
  // Use a model that has bash tool available
  const modelString = "anthropic:claude-sonnet-4-20250514";

  test("extracts tool section from agentInstructions first", () => {
    const globalContents = [
      `## Tool: bash
From global: Use rg for searching.
`,
    ];
    const contextContents = [
      `## Tool: bash
From context: Use fd for finding.
`,
    ];
    const agentInstructions = [
      `## Tool: bash
From agent: Use ripgrep alias.
`,
    ];

    const result = extractToolInstructions(globalContents, contextContents, modelString, {
      agentInstructions,
    });

    expect(result.bash).toBe(
      [
        "From agent: Use ripgrep alias.",
        "From context: Use fd for finding.",
        "From global: Use rg for searching.",
      ].join("\n\n")
    );
  });

  test("falls back to context when agentInstructions has no matching tool section", () => {
    const globalContents = [
      `## Tool: bash
From global: Use rg for searching.
`,
    ];
    const contextContents = [
      `## Tool: bash
From context: Use fd for finding.
`,
    ];
    const agentInstructions = [
      `## Tool: file_read
From agent: Read files carefully.
`,
    ];

    const result = extractToolInstructions(globalContents, contextContents, modelString, {
      agentInstructions,
    });

    expect(result.bash).toBe(
      ["From context: Use fd for finding.", "From global: Use rg for searching."].join("\n\n")
    );
  });

  test("keeps every matching context tool section before falling back to global", () => {
    const globalContents = [
      `## Tool: bash
From global: Use rg for searching.
`,
    ];
    const contextContents = [
      `## Tool: bash
From primary repo: Prefer git status --short.
`,
      `## Tool: bash
From secondary repo: Prefer rg --files before find.
`,
    ];

    const result = extractToolInstructions(globalContents, contextContents, modelString);

    expect(result.bash).toBe(
      [
        "From primary repo: Prefer git status --short.",
        "From secondary repo: Prefer rg --files before find.",
        "From global: Use rg for searching.",
      ].join("\n\n")
    );
  });

  test("falls back to global when neither agentInstructions nor context has tool section", () => {
    const globalContents = [
      `## Tool: bash
From global: Use rg for searching.
`,
    ];
    const contextContents = [`General context instructions.`];
    const agentInstructions = [`General agent instructions.`];

    const result = extractToolInstructions(globalContents, contextContents, modelString, {
      agentInstructions,
    });

    expect(result.bash).toContain("From global: Use rg for searching.");
  });

  test("returns empty object when no tool sections found", () => {
    const result = extractToolInstructions(["No tool sections here."], ["Nor here."], modelString, {
      agentInstructions: ["Or here."],
    });

    expect(result.bash).toBeUndefined();
  });

  test("a trailing Tool: section does not swallow the next file's unscoped content", () => {
    // Per-file extraction: file A ends with a Tool: section, file B starts
    // with plain text. Concatenating before extraction would pull file B's
    // unscoped content into the bash tool description.
    const contextContents = [
      `General guidance A.

## Tool: bash
Use rg for searching.
`,
      `Unscoped guidance B.
`,
    ];

    const result = extractToolInstructions([], contextContents, modelString);

    expect(result.bash).toBe("Use rg for searching.");
  });
});

describe("buildSystemMessage", () => {
  let tempDir: string;
  let projectDir: string;
  let workspaceDir: string;
  let globalDir: string;
  let mockHomedir: Mock<typeof os.homedir>;
  let runtime: LocalRuntime;
  let originalMuxRoot: string | undefined;

  beforeEach(async () => {
    // Snapshot any existing MUX_ROOT so we can restore it after the test.
    originalMuxRoot = process.env.MUX_ROOT;

    // Create temp directory for test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "systemMessage-test-"));
    projectDir = path.join(tempDir, "project");
    workspaceDir = path.join(tempDir, "workspace");
    globalDir = path.join(tempDir, ".mux");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(globalDir, { recursive: true });

    // Mock homedir to return our test directory (getXumHome will append .mux)
    mockHomedir = spyOn(os, "homedir");
    mockHomedir.mockReturnValue(tempDir);

    // Force mux home to our test .mux directory regardless of host MUX_ROOT.
    process.env.MUX_ROOT = globalDir;

    // Create a local runtime for tests
    runtime = new LocalRuntime(tempDir);
  });

  async function createMultiProjectFixture(): Promise<{
    metadata: WorkspaceMetadata;
    primaryWorkspaceRepoDir: string;
    secondaryWorkspaceRepoDir: string;
  }> {
    const primaryProjectDir = path.join(tempDir, "primary-project");
    const secondaryProjectDir = path.join(tempDir, "secondary-project");
    const primaryWorkspaceRepoDir = path.join(tempDir, "primary-workspace-repo");
    const secondaryWorkspaceRepoDir = path.join(tempDir, "secondary-workspace-repo");

    await fs.mkdir(primaryProjectDir, { recursive: true });
    await fs.mkdir(secondaryProjectDir, { recursive: true });
    await fs.mkdir(primaryWorkspaceRepoDir, { recursive: true });
    await fs.mkdir(secondaryWorkspaceRepoDir, { recursive: true });
    await fs.symlink(primaryWorkspaceRepoDir, path.join(workspaceDir, "primary"));
    await fs.symlink(secondaryWorkspaceRepoDir, path.join(workspaceDir, "secondary"));

    return {
      metadata: {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "primary",
        projectPath: primaryProjectDir,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        projects: [
          { projectName: "primary", projectPath: primaryProjectDir },
          { projectName: "secondary", projectPath: secondaryProjectDir },
        ],
      },
      primaryWorkspaceRepoDir,
      secondaryWorkspaceRepoDir,
    };
  }

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });

    // Restore environment override
    if (originalMuxRoot === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = originalMuxRoot;
    }

    // Restore the original homedir
    mockHomedir?.mockRestore();
  });

  test("includes general instructions in custom-instructions", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      `# General Instructions
Always be helpful.
Use clear examples.
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(metadata, runtime, workspaceDir);

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).toContain("Always be helpful.");
    expect(customInstructions).toContain("Use clear examples.");
  });

  describe("Claude global instruction compatibility", () => {
    const metadata = (): WorkspaceMetadata => ({
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    });

    const buildWithCompat = (modelString?: string, modes?: readonly string[]): Promise<string> =>
      buildSystemMessage(metadata(), runtime, workspaceDir, undefined, modelString, undefined, {
        claudeSkillsCompatEnabled: true,
        modes,
      });

    test("includes Claude instructions when compatibility is enabled", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.mkdir(claudeDir);
      await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "Claude global guidance.");

      const customInstructions = extractTagContent(await buildWithCompat(), "custom-instructions");

      expect(customInstructions).toContain("Claude global guidance.");
    });

    test("layers Claude instructions before native global instructions", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.mkdir(claudeDir);
      await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "Claude global guidance.");
      await fs.writeFile(path.join(globalDir, "AGENTS.md"), "Native global guidance.");

      const customInstructions = extractTagContent(await buildWithCompat(), "custom-instructions");

      expect(customInstructions).not.toBeNull();
      expect(customInstructions?.indexOf("Claude global guidance.")).toBeLessThan(
        customInstructions?.indexOf("Native global guidance.") ?? -1
      );
    });

    test("does not read Claude instructions when compatibility is disabled", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.mkdir(claudeDir);
      await fs.writeFile(path.join(claudeDir, "CLAUDE.md"), "Claude global guidance.");

      const systemMessage = await buildSystemMessage(metadata(), runtime, workspaceDir);

      expect(systemMessage).not.toContain("Claude global guidance.");
    });

    test("keeps Claude Model and Mode headings unscoped while native globals remain scoped", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.mkdir(claudeDir);
      await fs.writeFile(
        path.join(claudeDir, "CLAUDE.md"),
        `Claude general guidance.
## Model: sonnet
Claude model guidance stays shared.
## Mode: plan
Claude mode guidance stays shared.
`
      );
      await fs.writeFile(
        path.join(globalDir, "AGENTS.md"),
        `Native general guidance.
## Model: sonnet
Native model guidance is scoped.
## Mode: plan
Native mode guidance is scoped.
`
      );

      const systemMessage = await buildWithCompat("anthropic:claude-3.5-sonnet", ["plan"]);
      const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
      const modelInstructions =
        extractTagContent(systemMessage, "model-anthropic-claude-3-5-sonnet") ?? "";
      const modeInstructions = extractTagContent(systemMessage, "mode-plan") ?? "";

      expect(customInstructions).toContain("Claude model guidance stays shared.");
      expect(customInstructions).toContain("Claude mode guidance stays shared.");
      expect(customInstructions).not.toContain("Native model guidance is scoped.");
      expect(customInstructions).not.toContain("Native mode guidance is scoped.");
      expect(modelInstructions).toContain("Native model guidance is scoped.");
      expect(modelInstructions).not.toContain("Claude model guidance stays shared.");
      expect(modeInstructions).toContain("Native mode guidance is scoped.");
      expect(modeInstructions).not.toContain("Claude mode guidance stays shared.");
    });

    test("leaves the prompt unchanged when the Claude directory is missing", async () => {
      const withoutCompat = await buildSystemMessage(metadata(), runtime, workspaceDir);
      const withCompat = await buildWithCompat();

      expect(withCompat).toBe(withoutCompat);
    });

    test("includes Tool sections from Claude global instructions", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.mkdir(claudeDir);
      await fs.writeFile(
        path.join(claudeDir, "CLAUDE.md"),
        "## Tool: bash\nUse the Claude-compatible shell guidance.\n"
      );

      const toolInstructions = await readToolInstructions(
        metadata(),
        runtime,
        workspaceDir,
        "anthropic:claude-sonnet-4-20250514",
        undefined,
        undefined,
        true
      );

      expect(toolInstructions.bash).toBe("Use the Claude-compatible shell guidance.");
    });

    test("joins native global Tool sections before Claude compat Tool sections", async () => {
      const claudeDir = path.join(tempDir, ".claude");
      await fs.mkdir(claudeDir);
      await fs.writeFile(
        path.join(claudeDir, "CLAUDE.md"),
        "## Tool: bash\nClaude compat shell guidance.\n"
      );
      await fs.writeFile(
        path.join(globalDir, "AGENTS.md"),
        "## Tool: bash\nNative shell guidance.\n"
      );

      const toolInstructions = await readToolInstructions(
        metadata(),
        runtime,
        workspaceDir,
        "anthropic:claude-sonnet-4-20250514",
        undefined,
        undefined,
        true
      );

      // Tool extraction is highest-precedence first, so native global guidance
      // must precede the compat source even though the prompt orders compat first.
      expect(toolInstructions.bash).toBe(
        ["Native shell guidance.", "Claude compat shell guidance."].join("\n\n")
      );
    });
  });

  test("includes parent project AGENTS.md alongside sub-project AGENTS.md when subProjectPath is set", async () => {
    // Regression: the prompt builder previously read `workspacePath` (the
    // execution path = workspace_root + subProjectRelativePath) as if it were
    // the workspace root, so for sub-project workspaces it joined the
    // sub-project segment a second time and missed the parent AGENTS.md
    // entirely. We now derive the workspace root explicitly from runtime
    // metadata and read both files at the right paths.
    const subProjectDir = path.join(workspaceDir, "packages", "api");
    await fs.mkdir(subProjectDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      "# Parent Project\nParent project guidance.\n"
    );
    await fs.writeFile(
      path.join(subProjectDir, "AGENTS.md"),
      "# Sub-project Package API\nSub-project guidance.\n"
    );

    // The runtime must report `workspaceDir` as the workspace path so
    // `resolveWorkspaceRootPath` returns it (LocalRuntime returns its
    // constructor arg from getWorkspacePath).
    const subProjectRuntime = new LocalRuntime(workspaceDir);

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      subProjectPath: path.join(projectDir, "packages", "api"),
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(
      metadata,
      subProjectRuntime,
      // Callers pass the *execution* path (root + sub-project) here; the
      // function should still resolve the parent AGENTS.md correctly.
      subProjectDir
    );

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).toContain("Parent project guidance.");
    expect(customInstructions).toContain("Sub-project guidance.");
  });

  test("includes generic instructions from every project repo in a multi-project workspace", async () => {
    const { metadata, primaryWorkspaceRepoDir, secondaryWorkspaceRepoDir } =
      await createMultiProjectFixture();

    await fs.writeFile(
      path.join(primaryWorkspaceRepoDir, "AGENTS.md"),
      `# Primary Instructions
Use the primary project context.
`
    );
    await fs.writeFile(
      path.join(secondaryWorkspaceRepoDir, "AGENTS.md"),
      `# Secondary Instructions
Include the secondary project context too.
`
    );

    const systemMessage = await buildSystemMessage(metadata, runtime, workspaceDir);

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).toContain("Use the primary project context.");
    expect(customInstructions).toContain("Include the secondary project context too.");
  });

  describe("project customInstructions from config", () => {
    const singleProjectMetadata = (projectPath: string): WorkspaceMetadata => ({
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    });

    test("appends only the workspace's own project instructions", async () => {
      const projectConfigs = new Map<string, ProjectConfig>([
        [projectDir, { workspaces: [], customInstructions: "Never touch the legacy folder." }],
        [
          path.join(tempDir, "other-project"),
          { workspaces: [], customInstructions: "Unrelated project guidance." },
        ],
      ]);

      const systemMessage = await buildSystemMessage(
        singleProjectMetadata(projectDir),
        runtime,
        workspaceDir,
        undefined,
        undefined,
        undefined,
        { projectConfigs }
      );

      const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
      expect(customInstructions).toContain("Never touch the legacy folder.");
      expect(customInstructions).not.toContain("Unrelated project guidance.");
    });

    test("skips blank customInstructions", async () => {
      const projectConfigs = new Map<string, ProjectConfig>([
        [projectDir, { workspaces: [], customInstructions: "   \n\t" }],
      ]);

      const systemMessage = await buildSystemMessage(
        singleProjectMetadata(projectDir),
        runtime,
        workspaceDir,
        undefined,
        undefined,
        undefined,
        { projectConfigs }
      );

      expect(systemMessage).not.toContain("<custom-instructions>");
    });

    test("survives malformed non-string customInstructions in config.json", async () => {
      // config.json is hand-editable and loaded without schema validation; a
      // malformed value must be skipped, not brick every send from the project.
      const projectConfigs = new Map<string, ProjectConfig>([
        [projectDir, { workspaces: [], customInstructions: 42 } as unknown as ProjectConfig],
      ]);

      const systemMessage = await buildSystemMessage(
        singleProjectMetadata(projectDir),
        runtime,
        workspaceDir,
        undefined,
        undefined,
        undefined,
        { projectConfigs }
      );

      expect(systemMessage).not.toContain("<custom-instructions>");
    });

    test("includes customInstructions from every project in a multi-project workspace", async () => {
      const { metadata } = await createMultiProjectFixture();
      const projectConfigs = new Map<string, ProjectConfig>(
        (metadata.projects ?? []).map((project, index) => [
          project.projectPath,
          { workspaces: [], customInstructions: `Guidance for project number ${index + 1}.` },
        ])
      );

      const systemMessage = await buildSystemMessage(
        metadata,
        runtime,
        workspaceDir,
        undefined,
        undefined,
        undefined,
        { projectConfigs }
      );

      const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
      expect(customInstructions).toContain("Guidance for project number 1.");
      expect(customInstructions).toContain("Guidance for project number 2.");
    });

    test("honors scoped Model: sections like other Mux-dedicated sources", async () => {
      const projectConfigs = new Map<string, ProjectConfig>([
        [
          projectDir,
          {
            workspaces: [],
            customInstructions: `Unscoped project guidance.
## Model: sonnet
Scoped project model guidance.
`,
          },
        ],
      ]);

      const systemMessage = await buildSystemMessage(
        singleProjectMetadata(projectDir),
        runtime,
        workspaceDir,
        undefined,
        "anthropic:claude-3.5-sonnet",
        undefined,
        { projectConfigs }
      );

      const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
      expect(customInstructions).toContain("Unscoped project guidance.");
      expect(customInstructions).not.toContain("Scoped project model guidance.");

      const modelSection =
        extractTagContent(systemMessage, "model-anthropic-claude-3-5-sonnet") ?? "";
      expect(modelSection).toContain("Scoped project model guidance.");
    });
  });

  test("preserves bash tool instructions from every multi-project context source", async () => {
    const { metadata, primaryWorkspaceRepoDir, secondaryWorkspaceRepoDir } =
      await createMultiProjectFixture();

    await fs.writeFile(
      path.join(globalDir, "AGENTS.md"),
      `# Global Instructions
## Tool: bash
From global: this should only apply when context has no bash section.
`
    );
    await fs.writeFile(
      path.join(primaryWorkspaceRepoDir, "AGENTS.md"),
      `# Primary Instructions
## Tool: bash
From primary repo: prefer git status --short.
`
    );
    await fs.writeFile(
      path.join(secondaryWorkspaceRepoDir, "AGENTS.md"),
      `# Secondary Instructions
## Tool: bash
From secondary repo: prefer rg --files before find.
`
    );

    const toolInstructions = await readToolInstructions(
      metadata,
      runtime,
      workspaceDir,
      "anthropic:claude-sonnet-4-20250514"
    );

    expect(toolInstructions.bash).toBe(
      [
        "From primary repo: prefer git status --short.",
        "From secondary repo: prefer rg --files before find.",
        "From global: this should only apply when context has no bash section.",
      ].join("\n\n")
    );
  });

  test("includes model-specific section from workspace .mux/AGENTS.md when regex matches active model", async () => {
    await fs.mkdir(path.join(workspaceDir, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".mux", "AGENTS.md"),
      `# Instructions
## Model: sonnet
Respond to Sonnet tickets in two sentences max.
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(
      metadata,
      runtime,
      workspaceDir,
      undefined,
      "anthropic:claude-3.5-sonnet"
    );

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).not.toContain("Respond to Sonnet tickets in two sentences max.");

    expect(systemMessage).toContain("<model-anthropic-claude-3-5-sonnet>");
    expect(systemMessage).toContain("Respond to Sonnet tickets in two sentences max.");
    expect(systemMessage).toContain("</model-anthropic-claude-3-5-sonnet>");
  });

  test("ignores Model sections in shared workspace AGENTS.md (breaking change)", async () => {
    // Shared AGENTS.md is read by non-Xum agents too, so "Model:" headings
    // there are no longer parsed as Xum directives — they stay plain markdown
    // inside <custom-instructions>.
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      `# Instructions
## Model: sonnet
Respond to Sonnet tickets in two sentences max.
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(
      metadata,
      runtime,
      workspaceDir,
      undefined,
      "anthropic:claude-3.5-sonnet"
    );

    expect(systemMessage).not.toContain("<model-anthropic-claude-3-5-sonnet>");

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).toContain("Model: sonnet");
    expect(customInstructions).toContain("Respond to Sonnet tickets in two sentences max.");
  });

  test("includes mode-specific section from workspace .mux/AGENTS.md", async () => {
    await fs.mkdir(path.join(workspaceDir, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".mux", "AGENTS.md"),
      `# Instructions
## Mode: plan
Plan thoroughly before proposing.
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(
      metadata,
      runtime,
      workspaceDir,
      undefined,
      undefined,
      undefined,
      { modes: ["plan"] }
    );

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).not.toContain("Plan thoroughly before proposing.");

    expect(systemMessage).toContain("<mode-plan>");
    expect(systemMessage).toContain("Plan thoroughly before proposing.");
    expect(systemMessage).toContain("</mode-plan>");
  });

  test("Mode: plan matches custom plan-like agents via the effective mode candidate", async () => {
    // A custom plan-like agent runs with effectiveMode "plan" but keeps its
    // own agent id; both candidates are checked so "Mode: plan" guidance
    // still applies (and per-agent sections also match).
    await fs.mkdir(path.join(workspaceDir, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".mux", "AGENTS.md"),
      `## Mode: plan
Shared plan-mode guidance.

## Mode: my-planner
Planner-specific guidance.
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(
      metadata,
      runtime,
      workspaceDir,
      undefined,
      undefined,
      undefined,
      { modes: ["plan", "my-planner"] }
    );

    const modeSection = extractTagContent(systemMessage, "mode-plan") ?? "";
    expect(modeSection).toContain("Shared plan-mode guidance.");
    expect(modeSection).toContain("Planner-specific guidance.");
  });

  test("ignores Mode sections in shared workspace AGENTS.md and non-matching modes", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      `# Instructions
## Mode: plan
Shared plan guidance.
`
    );
    await fs.mkdir(path.join(workspaceDir, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".mux", "AGENTS.md"),
      `## Mode: exec
Exec-only guidance.
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(
      metadata,
      runtime,
      workspaceDir,
      undefined,
      undefined,
      undefined,
      { modes: ["plan"] }
    );

    // Shared AGENTS.md Mode: headings stay plain markdown; no mode tag is built
    // from them, and the .mux/AGENTS.md exec section does not match plan mode.
    expect(systemMessage).not.toContain("<mode-plan>");
    expect(systemMessage).not.toContain("Exec-only guidance.");

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).toContain("Shared plan guidance.");
  });

  test("scoped sections do not swallow the next mux file's unscoped content", async () => {
    // .mux/AGENTS.md ends with a Mode: section; .mux/AGENTS.local.md starts
    // with plain text. Extraction must run per file — concatenating first
    // would pull the local file's unscoped content into <mode-plan>.
    await fs.mkdir(path.join(workspaceDir, ".mux"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".mux", "AGENTS.md"),
      `General mux guidance.

## Mode: plan
Plan-only guidance.
`
    );
    await fs.writeFile(
      path.join(workspaceDir, ".mux", "AGENTS.local.md"),
      `Local unscoped guidance.
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(
      metadata,
      runtime,
      workspaceDir,
      undefined,
      undefined,
      undefined,
      { modes: ["plan"] }
    );

    const modeSection = extractTagContent(systemMessage, "mode-plan") ?? "";
    expect(modeSection).toContain("Plan-only guidance.");
    expect(modeSection).not.toContain("Local unscoped guidance.");

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).toContain("Local unscoped guidance.");
  });

  test("falls back to global model section when project lacks a match", async () => {
    await fs.writeFile(
      path.join(globalDir, "AGENTS.md"),
      `# Global Instructions
## Model: /openai:.*codex/i
OpenAI's GPT-5.1 Codex models already default to terse replies.
`
    );

    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      `# Project Instructions
General details only.
`
    );

    const metadata: WorkspaceMetadata = {
      id: "test-workspace",
      name: "test-workspace",
      projectName: "test-project",
      projectPath: projectDir,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    };

    const systemMessage = await buildSystemMessage(
      metadata,
      runtime,
      workspaceDir,
      undefined,
      "openai:gpt-5.1-codex"
    );

    const customInstructions = extractTagContent(systemMessage, "custom-instructions") ?? "";
    expect(customInstructions).not.toContain(
      "OpenAI's GPT-5.1 Codex models already default to terse replies."
    );

    expect(systemMessage).toContain("<model-openai-gpt-5-1-codex>");
    expect(systemMessage).toContain(
      "OpenAI's GPT-5.1 Codex models already default to terse replies."
    );
  });

  describe("agentSystemPrompt scoped instructions", () => {
    test("extracts model section from agentSystemPrompt", async () => {
      const agentSystemPrompt = `You are a helpful agent.

## Model: sonnet

Be extra concise when using Sonnet.
`;

      const metadata: WorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: projectDir,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      const systemMessage = await buildSystemMessage(
        metadata,
        runtime,
        workspaceDir,
        undefined,
        "anthropic:claude-3.5-sonnet",
        undefined,
        { agentSystemPromptSections: [agentSystemPrompt] }
      );

      // Agent instructions should have scoped sections stripped
      const agentInstructions = extractTagContent(systemMessage, "agent-instructions") ?? "";
      expect(agentInstructions).toContain("You are a helpful agent.");
      expect(agentInstructions).not.toContain("Be extra concise when using Sonnet.");

      // Model section should be extracted and injected
      expect(systemMessage).toContain("<model-anthropic-claude-3-5-sonnet>");
      expect(systemMessage).toContain("Be extra concise when using Sonnet.");
    });

    test("agentSystemPrompt model section takes precedence over .mux/AGENTS.md", async () => {
      await fs.mkdir(path.join(workspaceDir, ".mux"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, ".mux", "AGENTS.md"),
        `## Model: sonnet
From AGENTS.md: Be verbose.
`
      );

      const agentSystemPrompt = `## Model: sonnet
From agent: Be terse.
`;

      const metadata: WorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: projectDir,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      const systemMessage = await buildSystemMessage(
        metadata,
        runtime,
        workspaceDir,
        undefined,
        "anthropic:claude-3.5-sonnet",
        undefined,
        { agentSystemPromptSections: [agentSystemPrompt] }
      );

      expect(systemMessage).toContain("From agent: Be terse.");
      expect(systemMessage).toContain("From AGENTS.md: Be verbose.");
      expect(systemMessage.indexOf("From agent: Be terse.")).toBeLessThan(
        systemMessage.indexOf("From AGENTS.md: Be verbose.")
      );
    });

    test("falls back to .mux/AGENTS.md when agentSystemPrompt has no matching model section", async () => {
      await fs.mkdir(path.join(workspaceDir, ".mux"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, ".mux", "AGENTS.md"),
        `## Model: sonnet
From AGENTS.md: Sonnet instructions.
`
      );

      const agentSystemPrompt = `## Model: opus
From agent: Opus instructions.
`;

      const metadata: WorkspaceMetadata = {
        id: "test-workspace",
        name: "test-workspace",
        projectName: "test-project",
        projectPath: projectDir,
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      };

      const systemMessage = await buildSystemMessage(
        metadata,
        runtime,
        workspaceDir,
        undefined,
        "anthropic:claude-3.5-sonnet",
        undefined,
        { agentSystemPromptSections: [agentSystemPrompt] }
      );

      // Falls back to AGENTS.md since agent has no sonnet section
      expect(systemMessage).toContain("From AGENTS.md: Sonnet instructions.");
      expect(systemMessage).not.toContain("From agent: Opus instructions.");
    });
  });

  describe("instruction scoping matrix", () => {
    interface Scenario {
      name: string;
      mdContent: string;
      model?: string;
      assert: (message: string) => void;
    }

    const scopingScenarios: Scenario[] = [
      {
        name: "strips model sections when no model provided",
        mdContent: `# Notes
General guidance for everyone.

## Model: sonnet
Anthropic-only instructions.
`,
        assert: (message) => {
          const custom = extractTagContent(message, "custom-instructions") ?? "";
          expect(custom).toContain("General guidance for everyone.");
          expect(custom).not.toContain("Anthropic-only instructions.");
          expect(message).not.toContain("Anthropic-only instructions.");
        },
      },
      {
        name: "injects only the matching model section",
        mdContent: `General base instructions.

## Model: sonnet
Anthropic-only instructions.

## Model: /openai:.*/
OpenAI-only instructions.
`,
        model: "openai:gpt-5.1-codex",
        assert: (message) => {
          const custom = extractTagContent(message, "custom-instructions") ?? "";
          expect(custom).toContain("General base instructions.");
          expect(custom).not.toContain("Anthropic-only instructions.");
          expect(custom).not.toContain("OpenAI-only instructions.");

          const openaiSection = extractTagContent(message, "model-openai-gpt-5-1-codex") ?? "";
          expect(openaiSection).toContain("OpenAI-only instructions.");
          expect(openaiSection).not.toContain("Anthropic-only instructions.");
          expect(message).not.toContain("Anthropic-only instructions.");
        },
      },
    ];

    for (const scenario of scopingScenarios) {
      test(scenario.name, async () => {
        // Scoped Model: sections only activate in Xum-dedicated files.
        await fs.mkdir(path.join(workspaceDir, ".mux"), { recursive: true });
        await fs.writeFile(path.join(workspaceDir, ".mux", "AGENTS.md"), scenario.mdContent);

        const metadata: WorkspaceMetadata = {
          id: "test-workspace",
          name: "test-workspace",
          projectName: "test-project",
          projectPath: projectDir,
          runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        };

        const systemMessage = await buildSystemMessage(
          metadata,
          runtime,
          workspaceDir,
          undefined,
          scenario.model
        );

        scenario.assert(systemMessage);
      });
    }
  });
});
