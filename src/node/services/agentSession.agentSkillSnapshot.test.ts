import { describe, expect, it, mock, afterEach, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import type { AIService } from "@/node/services/aiService";

import { createAgentSessionHarness } from "./agentSession.testHarness";

describe("AgentSession.sendMessage (agent skill snapshots)", () => {
  async function createTestWorkspaceWithSkills(args: {
    skills: Array<{ skillName: string; skillBody: string }>;
  }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mux-agent-skill-"));

    for (const skill of args.skills) {
      const skillDir = path.join(tmp, ".mux", "skills", skill.skillName);
      await fs.mkdir(skillDir, { recursive: true });

      const skillMarkdown = `---\nname: ${skill.skillName}\ndescription: Test skill\n---\n\n${skill.skillBody}\n`;
      await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMarkdown, "utf-8");
    }

    return { workspacePath: tmp };
  }

  async function createTestWorkspaceWithSkill(args: { skillName: string; skillBody: string }) {
    return createTestWorkspaceWithSkills({ skills: [args] });
  }

  let historyCleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await historyCleanup?.();
  });

  function getMessageText(message: MuxMessage): string {
    const textPart = message.parts.find((part) => part.type === "text");
    if (textPart?.type !== "text") {
      throw new Error(`Expected text part for message ${message.id}`);
    }
    return textPart.text;
  }

  async function createSessionHarness(args: {
    workspacePath: string;
    workspaceId?: string;
    runtimeConfig?: FrontendWorkspaceMetadata["runtimeConfig"];
    aiServiceOverrides?: Partial<AIService>;
  }) {
    const workspaceId = args.workspaceId ?? "ws-test";
    const workspaceMeta: FrontendWorkspaceMetadata = {
      id: workspaceId,
      name: "ws",
      projectName: "proj",
      projectPath: args.workspacePath,
      namedWorkspacePath: args.workspacePath,
      runtimeConfig: args.runtimeConfig ?? { type: "local" },
    } as unknown as FrontendWorkspaceMetadata;
    const { session, historyService, cleanup } = await createAgentSessionHarness({
      workspaceId,
      aiServiceOverrides: {
        getWorkspaceMetadata: mock((_workspaceId: string) => Promise.resolve(Ok(workspaceMeta))),
        ...args.aiServiceOverrides,
      },
    });
    historyCleanup = cleanup;

    const messages: MuxMessage[] = [];
    const realAppend = historyService.appendToHistory.bind(historyService);
    const appendToHistory = spyOn(historyService, "appendToHistory").mockImplementation(
      async (wId: string, message: MuxMessage) => {
        messages.push(message);
        return realAppend(wId, message);
      }
    );

    return { session, appendToHistory, messages, historyService };
  }

  it("persists a synthetic agent skill snapshot before the user message", async () => {
    const workspaceId = "ws-test";

    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "test-skill",
      skillBody: "Follow this skill.",
    });

    const { session, appendToHistory, messages } = await createSessionHarness({
      workspaceId,
      workspacePath,
    });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/test-skill do X",
        skillName: "test-skill",
        scope: "project",
      },
    });

    expect(result.success).toBe(true);

    expect(appendToHistory.mock.calls).toHaveLength(2);
    const [snapshotMessage, userMessage] = messages;

    expect(snapshotMessage.role).toBe("user");
    expect(snapshotMessage.metadata?.synthetic).toBe(true);
    expect(snapshotMessage.metadata?.agentSkillSnapshot?.skillName).toBe("test-skill");
    expect(snapshotMessage.metadata?.agentSkillSnapshot?.sha256).toBeTruthy();

    const frontmatterYaml = snapshotMessage.metadata?.agentSkillSnapshot?.frontmatterYaml;
    expect(frontmatterYaml).toBeTruthy();
    expect(frontmatterYaml ?? "").toContain("name:");
    expect(frontmatterYaml ?? "").toContain("description:");

    const snapshotText = snapshotMessage.parts.find((p) => p.type === "text")?.text;
    expect(snapshotText).toContain("<agent-skill");
    expect(snapshotText).toContain("Follow this skill.");

    expect(userMessage.role).toBe("user");
    const userText = userMessage.parts.find((p) => p.type === "text")?.text;
    expect(userText).toBe("do X");
  });

  it("honors disableWorkspaceAgents when resolving skill snapshots", async () => {
    const workspaceId = "ws-test";

    const { workspacePath: projectPath } = await createTestWorkspaceWithSkill({
      // Built-in: use a project-local override to ensure we don't accidentally fall back.
      skillName: "init",
      skillBody: "Project override for init skill.",
    });

    const srcBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-agent-skill-src-"));

    const { session, appendToHistory, messages } = await createSessionHarness({
      workspaceId,
      workspacePath: projectPath,
      runtimeConfig: { type: "worktree", srcBaseDir },
    });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      disableWorkspaceAgents: true,
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/init",
        skillName: "init",
        scope: "project",
      },
    });

    expect(result.success).toBe(true);

    expect(appendToHistory.mock.calls).toHaveLength(2);
    const [snapshotMessage] = messages;

    const snapshotText = snapshotMessage.parts.find((p) => p.type === "text")?.text;
    expect(snapshotText).toContain("Project override for init skill.");
  });

  it("resolves checkout-level plugin skills for subproject execution paths (agent-plugins)", async () => {
    const workspaceId = "ws-test";

    // agent-plugins experiment: the workspace executes in a subdirectory of the
    // checkout, while the plugin container lives at the checkout level.
    const checkout = await fs.mkdtemp(path.join(os.tmpdir(), "mux-agent-skill-checkout-"));
    const subprojectPath = path.join(checkout, "packages", "app");
    await fs.mkdir(subprojectPath, { recursive: true });
    const xumHome = await fs.mkdtemp(path.join(os.tmpdir(), "mux-agent-skill-muxhome-"));

    const pluginDir = path.join(checkout, ".mux", "plugins", "demo-plugin");
    const skillDir = path.join(pluginDir, "skills", "plugin-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "demo-plugin",
        version: "1.0.0",
        description: "demo",
      }),
      "utf-8"
    );
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: plugin-skill\ndescription: Plugin skill\n---\n\nFollow the plugin skill.\n",
      "utf-8"
    );

    const { session, appendToHistory, messages } = await createSessionHarness({
      workspaceId,
      workspacePath: subprojectPath,
      aiServiceOverrides: {
        isAgentPluginsEnabled: () => true,
        // Mirrors AIService: checkout root anchors plugin containers even though
        // the execution path is the subproject directory.
        resolveXumToolScopeForWorkspace: () => ({
          type: "project",
          xumHome,
          projectRoot: subprojectPath,
          projectStorageAuthority: "host-local",
          checkoutRoot: checkout,
        }),
      },
    });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/plugin-skill do X",
        skillName: "plugin-skill",
        scope: "project",
      },
    });

    expect(result.success).toBe(true);

    expect(appendToHistory.mock.calls).toHaveLength(2);
    const [snapshotMessage] = messages;

    expect(snapshotMessage.metadata?.agentSkillSnapshot?.skillName).toBe("plugin-skill");
    const snapshotText = snapshotMessage.parts.find((p) => p.type === "text")?.text;
    expect(snapshotText).toContain("Follow the plugin skill.");
  });

  it("dedupes identical skill snapshots when recently inserted", async () => {
    const workspaceId = "ws-test";

    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "test-skill",
      skillBody: "Follow this skill.",
    });

    const { session, appendToHistory } = await createSessionHarness({
      workspaceId,
      workspacePath,
    });

    const baseOptions = {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/test-skill do X",
        skillName: "test-skill",
        scope: "project",
      },
    };

    const first = await session.sendMessage("do X", baseOptions);
    expect(first.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);

    const second = await session.sendMessage("do Y", {
      ...baseOptions,
      muxMetadata: {
        ...baseOptions.muxMetadata,
        rawCommand: "/test-skill do Y",
      },
    });

    expect(second.success).toBe(true);
    // First send: snapshot + user. Second send: user only.
    expect(appendToHistory.mock.calls).toHaveLength(3);

    const appendedIds = appendToHistory.mock.calls.map((call) => call[1].id);
    const secondSendAppendedIds = appendedIds.slice(2);
    expect(secondSendAppendedIds).toHaveLength(1);
    expect(secondSendAppendedIds[0]).toStartWith("user-");
  });

  it("persists a new skill snapshot when frontmatter changes (body unchanged)", async () => {
    const workspaceId = "ws-test";

    const skillName = "test-skill";
    const skillBody = "Follow this skill.";

    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName,
      skillBody,
    });

    const { session, appendToHistory, messages } = await createSessionHarness({
      workspaceId,
      workspacePath,
    });

    const baseOptions = {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/test-skill do X",
        skillName,
        scope: "project",
      },
    };

    const first = await session.sendMessage("do X", baseOptions);
    expect(first.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);

    const firstSnapshot = messages[0];
    expect(firstSnapshot.id).toStartWith("agent-skill-snapshot-");

    const firstSnapshotText = firstSnapshot.parts.find((p) => p.type === "text")?.text;
    expect(firstSnapshotText).toBeTruthy();

    const firstSha = firstSnapshot.metadata?.agentSkillSnapshot?.sha256;
    expect(firstSha).toBeTruthy();

    // Update frontmatter only.
    const skillFilePath = path.join(workspacePath, ".mux", "skills", skillName, "SKILL.md");
    const updatedSkillMarkdown = `---\nname: ${skillName}\ndescription: Updated description\n---\n\n${skillBody}\n`;
    await fs.writeFile(skillFilePath, updatedSkillMarkdown, "utf-8");

    const second = await session.sendMessage("do Y", {
      ...baseOptions,
      muxMetadata: {
        ...baseOptions.muxMetadata,
        rawCommand: "/test-skill do Y",
      },
    });

    expect(second.success).toBe(true);

    // Second send should persist a new snapshot (frontmatter differs) + user message.
    expect(appendToHistory.mock.calls).toHaveLength(4);

    const secondSnapshot = messages[2];
    expect(secondSnapshot.id).toStartWith("agent-skill-snapshot-");

    const secondSnapshotText = secondSnapshot.parts.find((p) => p.type === "text")?.text;
    expect(secondSnapshotText).toBe(firstSnapshotText);

    const secondSha = secondSnapshot.metadata?.agentSkillSnapshot?.sha256;
    expect(secondSha).toBeTruthy();
    expect(secondSha).not.toBe(firstSha);

    const secondFrontmatter = secondSnapshot.metadata?.agentSkillSnapshot?.frontmatterYaml;
    expect(secondFrontmatter ?? "").toContain("Updated description");
  });

  it("materializes multiple snapshots for plural agentSkillRefs", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkills({
      skills: [
        { skillName: "alpha-skill", skillBody: "Follow alpha." },
        { skillName: "beta-skill", skillBody: "Follow beta." },
      ],
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "normal",
        agentSkillRefs: [
          { skillName: "alpha-skill", scope: "project", source: "inline" },
          { skillName: "beta-skill", scope: "project", source: "inline" },
        ],
      },
    });

    expect(result.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(3);

    const [alphaSnapshot, betaSnapshot, userMessage] = messages;
    expect(alphaSnapshot.metadata?.synthetic).toBe(true);
    expect(alphaSnapshot.metadata?.agentSkillSnapshot?.skillName).toBe("alpha-skill");
    expect(getMessageText(alphaSnapshot)).toContain("Follow alpha.");

    expect(betaSnapshot.metadata?.synthetic).toBe(true);
    expect(betaSnapshot.metadata?.agentSkillSnapshot?.skillName).toBe("beta-skill");
    expect(getMessageText(betaSnapshot)).toContain("Follow beta.");

    expect(userMessage.role).toBe("user");
    expect(getMessageText(userMessage)).toBe("do X");
  });

  it("dedupes slash + inline refs for the same skill, slash wins", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "test-skill",
      skillBody: "Follow slash skill.",
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/test-skill do X",
        skillName: "test-skill",
        scope: "project",
        agentSkillRefs: [{ skillName: "test-skill", scope: "global", source: "inline" }],
      },
    });

    expect(result.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);

    const [snapshotMessage, userMessage] = messages;
    expect(snapshotMessage.metadata?.synthetic).toBe(true);
    expect(snapshotMessage.metadata?.agentSkillSnapshot?.skillName).toBe("test-skill");
    expect(snapshotMessage.metadata?.agentSkillSnapshot?.scope).toBe("project");
    expect(getMessageText(snapshotMessage)).toContain("Follow slash skill.");
    expect(getMessageText(userMessage)).toBe("do X");
  });

  it("skips inline refs with invalid skill names silently", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "valid-skill",
      skillBody: "Follow valid skill.",
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "normal",
        agentSkillRefs: [
          { skillName: "Invalid_Name", scope: "project", source: "inline" },
          { skillName: "valid-skill", scope: "project", source: "inline" },
        ],
      },
    });

    expect(result.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);
    expect(messages[0].metadata?.agentSkillSnapshot?.skillName).toBe("valid-skill");
    expect(getMessageText(messages[0])).toContain("Follow valid skill.");
    expect(getMessageText(messages[1])).toBe("do X");
  });

  it("skips inline refs whose skill cannot be read silently", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "alpha-skill",
      skillBody: "Follow alpha.",
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "normal",
        agentSkillRefs: [
          { skillName: "alpha-skill", scope: "project", source: "inline" },
          { skillName: "missing-skill", scope: "project", source: "inline" },
        ],
      },
    });

    expect(result.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);
    expect(messages[0].metadata?.agentSkillSnapshot?.skillName).toBe("alpha-skill");
    expect(getMessageText(messages[0])).toContain("Follow alpha.");
    expect(getMessageText(messages[1])).toBe("do X");
  });

  it("still throws when a slash skill name is invalid", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkills({ skills: [] });
    const { session, appendToHistory } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/Invalid_Name do X",
        skillName: "Invalid_Name",
        scope: "project",
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected invalid slash skill send to fail");
    }
    expect(result.error.type).toBe("unknown");
    if (result.error.type !== "unknown") {
      throw new Error("Expected invalid slash skill failure to use unknown error shape");
    }
    expect(result.error.raw).toContain("Invalid agent skill name");
    expect(appendToHistory.mock.calls).toHaveLength(0);
  });

  it("still throws when a slash skill is missing", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkills({ skills: [] });
    const { session, appendToHistory } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("do X", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/missing-skill do X",
        skillName: "missing-skill",
        scope: "project",
      },
    });

    expect(result.success).toBe(false);
    expect(appendToHistory.mock.calls).toHaveLength(0);
  });

  it("dedupes against recent history per-skill", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkills({
      skills: [
        { skillName: "alpha-skill", skillBody: "Follow alpha." },
        { skillName: "beta-skill", skillBody: "Follow beta." },
      ],
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const first = await session.sendMessage("first", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "normal",
        agentSkillRefs: [{ skillName: "alpha-skill", scope: "project", source: "inline" }],
      },
    });
    expect(first.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);

    const second = await session.sendMessage("second", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "normal",
        agentSkillRefs: [
          { skillName: "alpha-skill", scope: "project", source: "inline" },
          { skillName: "beta-skill", scope: "project", source: "inline" },
        ],
      },
    });

    expect(second.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(4);
    expect(messages[2].metadata?.agentSkillSnapshot?.skillName).toBe("beta-skill");
    expect(getMessageText(messages[2])).toContain("Follow beta.");
    expect(getMessageText(messages[3])).toBe("second");
  });

  it("substitutes $ARGUMENTS/$N placeholders in slash-invoked snapshot bodies", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "fix-issue",
      skillBody: "Fix issue $1 with priority $2.\nSummary: $ARGUMENTS",
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("Using skill fix-issue: 123 high", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/fix-issue 123 high",
        skillName: "fix-issue",
        scope: "project",
        arguments: "123 high",
      },
    });

    expect(result.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);

    const [snapshotMessage, userMessage] = messages;
    expect(getMessageText(snapshotMessage)).toContain(
      "Fix issue 123 with priority high.\nSummary: 123 high"
    );
    // The user message still shows what the user typed; only the snapshot body changes.
    expect(getMessageText(userMessage)).toBe("Using skill fix-issue: 123 high");
  });

  it("materializes distinct snapshots for the same skill with different arguments", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "fix-issue",
      skillBody: "Fix issue $ARGUMENTS.",
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const baseOptions = {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
    };

    const first = await session.sendMessage("Using skill fix-issue: 123", {
      ...baseOptions,
      muxMetadata: {
        type: "agent-skill" as const,
        rawCommand: "/fix-issue 123",
        skillName: "fix-issue",
        scope: "project" as const,
        arguments: "123",
      },
    });
    expect(first.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);

    const second = await session.sendMessage("Using skill fix-issue: 456", {
      ...baseOptions,
      muxMetadata: {
        type: "agent-skill" as const,
        rawCommand: "/fix-issue 456",
        skillName: "fix-issue",
        scope: "project" as const,
        arguments: "456",
      },
    });
    expect(second.success).toBe(true);

    // Different arguments produce different substituted bodies, so the sha256 dedupe
    // must NOT collapse the second snapshot: snapshot + user, snapshot + user.
    expect(appendToHistory.mock.calls).toHaveLength(4);

    const firstSnapshot = messages[0];
    const secondSnapshot = messages[2];
    expect(getMessageText(firstSnapshot)).toContain("Fix issue 123.");
    expect(getMessageText(secondSnapshot)).toContain("Fix issue 456.");
    expect(firstSnapshot.metadata?.agentSkillSnapshot?.sha256).not.toBe(
      secondSnapshot.metadata?.agentSkillSnapshot?.sha256
    );
  });

  it("still dedupes repeated invocations with identical arguments", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "fix-issue",
      skillBody: "Fix issue $ARGUMENTS.",
    });
    const { session, appendToHistory } = await createSessionHarness({ workspacePath });

    const options = {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill" as const,
        rawCommand: "/fix-issue 123",
        skillName: "fix-issue",
        scope: "project" as const,
        arguments: "123",
      },
    };

    const first = await session.sendMessage("Using skill fix-issue: 123", options);
    expect(first.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);

    const second = await session.sendMessage("Using skill fix-issue: 123", options);
    expect(second.success).toBe(true);
    // Identical substituted body → snapshot deduped; only the user message is appended.
    expect(appendToHistory.mock.calls).toHaveLength(3);
  });

  it("leaves placeholders in inline-referenced skill bodies untouched", async () => {
    const skillBody = "Fix issue $1 with $ARGUMENTS.";
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "fix-issue",
      skillBody,
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("Please follow $fix-issue for 123", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "normal",
        agentSkillRefs: [{ skillName: "fix-issue", scope: "project", source: "inline" }],
      },
    });

    expect(result.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);
    // Inline refs carry no argument concept: the body must stay byte-identical.
    expect(getMessageText(messages[0])).toContain(skillBody);
  });

  it("keeps bodies without placeholders byte-identical when arguments are provided", async () => {
    // Note: $0 and $ARG are not placeholders; $100 would be ($1 + literal "00").
    const skillBody = "Follow this skill. Cost is $0 and $ARG stays.";
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "no-placeholders",
      skillBody,
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("Using skill no-placeholders: 123 high", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/no-placeholders 123 high",
        skillName: "no-placeholders",
        scope: "project",
        arguments: "123 high",
      },
    });

    expect(result.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);
    // Fallback: no placeholders → body untouched; the arguments stay visible in the
    // user message only.
    expect(getMessageText(messages[0])).toContain(skillBody);
  });

  it("substitutes placeholders with empty strings when a slash invocation has no arguments", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "fix-issue",
      skillBody: "Fix issue [$1] with [$ARGUMENTS].",
    });
    const { session, appendToHistory, messages } = await createSessionHarness({ workspacePath });

    const result = await session.sendMessage("Use skill fix-issue", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/fix-issue",
        skillName: "fix-issue",
        scope: "project",
        arguments: "",
      },
    });

    expect(result.success).toBe(true);
    expect(appendToHistory.mock.calls).toHaveLength(2);
    expect(getMessageText(messages[0])).toContain("Fix issue [] with [].");
  });

  it("leaves dynamic context directives literal and executes nothing when the experiment is off", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "dyn",
      // The directive has an observable side effect so we can prove it never ran.
      skillBody: "Context:\n!`touch dynamic-context-ran.marker`\nDone.",
    });
    const isExperimentEnabled = mock(() => false);
    const { session, messages } = await createSessionHarness({
      workspacePath,
      aiServiceOverrides: { isExperimentEnabled },
    });

    const result = await session.sendMessage("use dyn", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/dyn",
        skillName: "dyn",
        scope: "project",
      },
    });

    expect(result.success).toBe(true);
    expect(isExperimentEnabled).toHaveBeenCalledWith(EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT);
    // Body unchanged: the directive stays literal text...
    expect(getMessageText(messages[0])).toContain("!`touch dynamic-context-ran.marker`");
    // ...and no command executed (the side-effect marker must not exist).
    expect(existsSync(path.join(workspacePath, "dynamic-context-ran.marker"))).toBe(false);
  });

  it("replaces whole-line directives with command output when the experiment is on", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "dyn",
      skillBody: "Context:\n!`echo dynamic-ok`\n!`exit 7`\nDone.",
    });
    const { session, messages } = await createSessionHarness({
      workspacePath,
      aiServiceOverrides: {
        isExperimentEnabled: mock((id) => id === EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT),
      },
    });

    const result = await session.sendMessage("use dyn", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/dyn",
        skillName: "dyn",
        scope: "project",
      },
    });

    expect(result.success).toBe(true);
    const text = getMessageText(messages[0]);
    expect(text).toContain("```text (output of: echo dynamic-ok)\ndynamic-ok\n```");
    expect(text).not.toContain("!`echo dynamic-ok`");
    // Real runtime exit-code plumbing: non-zero exit still injects, annotated.
    expect(text).toContain("[exit code 7]");
  });

  it("bounds directive output while reading and still appends the truncation marker", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "dyn",
      // ~64KB of output, well over the 16KB cap. The capped reader must bound
      // accumulation during the read (not just post-hoc) and hand the module an
      // over-cap payload so its truncation marker still fires.
      skillBody: "!`head -c 65536 /dev/zero | tr '\\\\0' x`",
    });
    const { session, messages } = await createSessionHarness({
      workspacePath,
      aiServiceOverrides: {
        isExperimentEnabled: mock((id) => id === EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT),
      },
    });

    const result = await session.sendMessage("use dyn", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/dyn",
        skillName: "dyn",
        scope: "project",
      },
    });

    expect(result.success).toBe(true);
    const text = getMessageText(messages[0]);
    expect(text).toContain("[output truncated at 16KB]");
    // The materialized snapshot must carry at most the cap (+ formatting), not 64KB.
    expect(text.length).toBeLessThan(32 * 1024);
  });

  it("composes dynamic context with $ARGUMENTS substitution (arguments first)", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "dyn",
      skillBody: "!`echo $1`",
    });
    const { session, messages } = await createSessionHarness({
      workspacePath,
      aiServiceOverrides: {
        isExperimentEnabled: mock((id) => id === EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT),
      },
    });

    const result = await session.sendMessage("use dyn hi", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/dyn hi",
        skillName: "dyn",
        scope: "project",
        arguments: "hi",
      },
    });

    expect(result.success).toBe(true);
    // $1 → "hi" happens before execution, so the command itself sees the argument.
    expect(getMessageText(messages[0])).toContain("```text (output of: echo hi)\nhi\n```");
  });

  it("injects dynamic context for inline skill refs (also user-initiated)", async () => {
    const { workspacePath } = await createTestWorkspaceWithSkill({
      skillName: "dyn",
      skillBody: "!`echo inline-ok`",
    });
    const { session, messages } = await createSessionHarness({
      workspacePath,
      aiServiceOverrides: {
        isExperimentEnabled: mock((id) => id === EXPERIMENT_IDS.SKILL_DYNAMIC_CONTEXT),
      },
    });

    const result = await session.sendMessage("Please follow $dyn", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      muxMetadata: {
        type: "normal",
        agentSkillRefs: [{ skillName: "dyn", scope: "project", source: "inline" }],
      },
    });

    expect(result.success).toBe(true);
    expect(getMessageText(messages[0])).toContain(
      "```text (output of: echo inline-ok)\ninline-ok\n```"
    );
  });

  it("truncates edits starting from preceding skill/file snapshots", async () => {
    const workspaceId = "ws-test";

    const fileSnapshotId = "file-snapshot-0";
    const skillSnapshotId = "agent-skill-snapshot-0";
    const userMessageId = "user-0";

    const historyMessages: MuxMessage[] = [
      createMuxMessage(fileSnapshotId, "user", "<file>...</file>", {
        historySequence: 0,
        synthetic: true,
        fileAtMentionSnapshot: ["@file:foo.txt"],
      }),
      createMuxMessage(skillSnapshotId, "user", "<agent-skill>...</agent-skill>", {
        historySequence: 1,
        synthetic: true,
        agentSkillSnapshot: {
          skillName: "test-skill",
          scope: "project",
          sha256: "abc",
        },
      }),
      createMuxMessage(userMessageId, "user", "do X", {
        historySequence: 2,
        muxMetadata: {
          type: "agent-skill",
          rawCommand: "/test-skill do X",
          skillName: "test-skill",
          scope: "project",
        },
      }),
    ];

    const { session, historyService, cleanup } = await createAgentSessionHarness({ workspaceId });
    historyCleanup = cleanup;

    // Seed history messages before setting up spies
    for (const msg of historyMessages) {
      await historyService.appendToHistory(workspaceId, msg);
    }

    const truncateAfterMessage = spyOn(historyService, "truncateAfterMessage");
    spyOn(historyService, "appendToHistory");

    const result = await session.sendMessage("edited", {
      model: "anthropic:claude-3-5-sonnet-latest",
      agentId: "exec",
      editMessageId: userMessageId,
    });

    expect(result.success).toBe(true);
    expect(truncateAfterMessage.mock.calls).toHaveLength(1);
    // Should truncate from the earliest contiguous snapshot (file snapshot).
    expect(truncateAfterMessage.mock.calls[0][1]).toBe(fileSnapshotId);
  });
});
