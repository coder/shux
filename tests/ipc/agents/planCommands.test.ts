import * as path from "path";
/**
 * Integration tests for plan commands (/plan, /plan open)
 *
 * Tests:
 * - getPlanContent API returns plan file content
 * - openWorkspaceInEditor API attempts to open file with configured editor
 * - Plan file CRUD operations
 */

import * as fs from "fs/promises";
import { shouldRunIntegrationTests, createTestEnvironment, cleanupTestEnvironment } from "../setup";
import type { TestEnvironment } from "../setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  generateBranchName,
  trustProject,
} from "../helpers";
import { detectDefaultTrunkBranch } from "../../../src/node/git";
import { getPlanFilePath } from "../../../src/common/utils/planStorage";
import { createMuxMessage } from "../../../src/common/types/message";
import { expandTilde } from "../../../src/node/runtime/tildeExpansion";

// Skip all tests if TEST_INTEGRATION is not set
const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Plan Commands Integration", () => {
  let env: TestEnvironment;
  let repoPath: string;

  beforeAll(async () => {
    env = await createTestEnvironment();
    repoPath = await createTempGitRepo();
    await trustProject(env, repoPath);
  }, 30000);

  afterAll(async () => {
    if (repoPath) {
      await cleanupTempGitRepo(repoPath);
    }
    if (env) {
      await cleanupTestEnvironment(env);
    }
    // Windows cleanup can exceed Jest's default hook timeout when Git has just torn down worktrees.
  }, 120000);

  describe("getPlanContent", () => {
    it("should return error when no plan file exists", async () => {
      const branchName = generateBranchName("plan-no-file");
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Failed to create workspace");

      const workspaceId = createResult.metadata.id;

      try {
        const result = await env.orpc.workspace.getPlanContent({ workspaceId });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("not found");
        }
      } finally {
        await env.orpc.workspace.remove({ workspaceId });
      }
    }, 30000);

    it("should return plan content when plan file exists", async () => {
      const branchName = generateBranchName("plan-with-file");
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Failed to create workspace");

      const workspaceId = createResult.metadata.id;
      const workspaceName = createResult.metadata.name;
      const projectName = createResult.metadata.projectName;

      try {
        // Create a plan file
        const planPath = getPlanFilePath(workspaceName, projectName);
        const expandedPlanPath = expandTilde(planPath);
        const planDir = path.dirname(expandedPlanPath);
        await fs.mkdir(planDir, { recursive: true });

        const planContent = "# Test Plan\n\n## Step 1\n\nDo something\n\n## Step 2\n\nDo more";
        await fs.writeFile(expandedPlanPath, planContent);

        const result = await env.orpc.workspace.getPlanContent({ workspaceId });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.content).toBe(planContent);
          // Path should be expanded (no tilde) so it works with editor deep links
          expect(result.data.path).toBe(expandedPlanPath);
          expect(result.data.path).not.toContain("~");
        }
      } finally {
        await env.orpc.workspace.remove({ workspaceId });
      }
    }, 30000);

    it("should handle empty plan file", async () => {
      const branchName = generateBranchName("plan-empty");
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Failed to create workspace");

      const workspaceId = createResult.metadata.id;
      const workspaceName = createResult.metadata.name;
      const projectName = createResult.metadata.projectName;

      try {
        // Create an empty plan file
        const planPath = getPlanFilePath(workspaceName, projectName);
        const expandedPlanPath = expandTilde(planPath);
        const planDir = path.dirname(expandedPlanPath);
        await fs.mkdir(planDir, { recursive: true });
        await fs.writeFile(expandedPlanPath, "");

        const result = await env.orpc.workspace.getPlanContent({ workspaceId });

        // Empty file should still be returned (not an error)
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.content).toBe("");
        }
      } finally {
        await env.orpc.workspace.remove({ workspaceId });
      }
    }, 30000);
  });

  describe("replaceChatHistory", () => {
    it("should delete plan file when deletePlanFile is true", async () => {
      const branchName = generateBranchName("start-here-delete-plan");
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Failed to create workspace");

      const workspaceId = createResult.metadata.id;
      const workspaceName = createResult.metadata.name;
      const projectName = createResult.metadata.projectName;

      try {
        // Create a plan file at the canonical path
        const planPath = getPlanFilePath(workspaceName, projectName);
        const expandedPlanPath = expandTilde(planPath);
        await fs.mkdir(path.dirname(expandedPlanPath), { recursive: true });
        await fs.writeFile(expandedPlanPath, "# Test Plan\n");

        const summaryMessage = createMuxMessage(
          `start-here-test-${Date.now()}`,
          "assistant",
          "summary",
          { timestamp: Date.now(), compacted: true }
        );

        const replaceResult = await env.orpc.workspace.replaceChatHistory({
          workspaceId,
          summaryMessage,
          deletePlanFile: true,
        });

        expect(replaceResult.success).toBe(true);

        // Plan file should be deleted
        await expect(fs.stat(expandedPlanPath)).rejects.toThrow();

        // And the plan content API should report it missing
        const getPlanResult = await env.orpc.workspace.getPlanContent({ workspaceId });
        expect(getPlanResult.success).toBe(false);
      } finally {
        await env.orpc.workspace.remove({ workspaceId });
      }
    }, 30000);

    it("should preserve agentId metadata in summary message", async () => {
      const branchName = generateBranchName("start-here-preserve-agent-id");
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Failed to create workspace");

      const workspaceId = createResult.metadata.id;

      try {
        const summaryMessage = createMuxMessage(
          `start-here-test-${Date.now()}`,
          "assistant",
          "summary",
          { timestamp: Date.now(), compacted: true, agentId: "plan" }
        );

        const replaceResult = await env.orpc.workspace.replaceChatHistory({
          workspaceId,
          summaryMessage,
        });

        expect(replaceResult.success).toBe(true);

        const chatHistoryPath = path.join(
          path.join(env.config.sessionsDir, workspaceId),
          "chat.jsonl"
        );
        const data = await fs.readFile(chatHistoryPath, "utf-8");
        const firstLine = data
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0);

        expect(firstLine).toBeTruthy();
        const historyEntry = JSON.parse(firstLine!) as { metadata?: { agentId?: string } };
        expect(historyEntry.metadata?.agentId).toBe("plan");
      } finally {
        await env.orpc.workspace.remove({ workspaceId });
      }
    }, 30000);
  });

  it("should preserve existing history and append a durable boundary in append-compaction-boundary mode", async () => {
    const branchName = generateBranchName("start-here-append-boundary");
    const trunkBranch = await detectDefaultTrunkBranch(repoPath);

    const createResult = await env.orpc.workspace.create({
      projectPath: repoPath,
      branchName,
      trunkBranch,
    });

    expect(createResult.success).toBe(true);
    if (!createResult.success) throw new Error("Failed to create workspace");

    const workspaceId = createResult.metadata.id;

    try {
      const legacySummary = createMuxMessage(
        `legacy-summary-${Date.now()}`,
        "assistant",
        "legacy summary",
        {
          timestamp: Date.now(),
          compacted: true,
        }
      );

      const initialReplaceResult = await env.orpc.workspace.replaceChatHistory({
        workspaceId,
        summaryMessage: legacySummary,
      });
      expect(initialReplaceResult.success).toBe(true);

      // Inject malformed boundary metadata directly to verify self-healing epoch derivation.
      const malformedBoundaryId = `malformed-boundary-${Date.now()}`;
      const malformedBoundaryMessage = createMuxMessage(
        malformedBoundaryId,
        "assistant",
        "malformed boundary",
        {
          timestamp: Date.now(),
          compacted: false,
          compactionBoundary: true,
          compactionEpoch: 999,
        }
      );

      const chatHistoryPath = path.join(
        path.join(env.config.sessionsDir, workspaceId),
        "chat.jsonl"
      );
      await fs.appendFile(
        chatHistoryPath,
        JSON.stringify({ ...malformedBoundaryMessage, workspaceId }) + "\n"
      );

      const appendSummary = createMuxMessage(
        `append-summary-${Date.now()}`,
        "assistant",
        "append summary",
        {
          timestamp: Date.now(),
          compacted: "user",
          agentId: "plan",
        }
      );

      const appendResult = await env.orpc.workspace.replaceChatHistory({
        workspaceId,
        summaryMessage: appendSummary,
        mode: "append-compaction-boundary",
      });

      expect(appendResult.success).toBe(true);

      // Appending a durable boundary rotates the sealed prefix (legacy summary +
      // malformed boundary) into chat-archive.jsonl; full history spans both files.
      const archivePath = path.join(
        path.join(env.config.sessionsDir, workspaceId),
        "chat-archive.jsonl"
      );
      const archiveData = await fs.readFile(archivePath, "utf-8");
      const activeData = await fs.readFile(chatHistoryPath, "utf-8");

      // The active file holds only the new durable boundary onward.
      const activeEntries = activeData
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { id: string });
      expect(activeEntries.map((entry) => entry.id)).toEqual([appendSummary.id]);

      const data = archiveData + activeData;
      const entries = data
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map(
          (line) =>
            JSON.parse(line) as {
              id: string;
              metadata?: {
                compacted?: "user" | "idle" | boolean;
                compactionBoundary?: boolean;
                compactionEpoch?: number;
              };
            }
        );

      expect(entries.length).toBe(3);
      expect(entries[0]?.id).toBe(legacySummary.id);
      expect(entries[1]?.id).toBe(malformedBoundaryId);

      const appendedEntry = entries[2];
      expect(appendedEntry?.id).toBe(appendSummary.id);
      expect(appendedEntry?.metadata?.compacted).toBe("user");
      expect(appendedEntry?.metadata?.compactionBoundary).toBe(true);
      // Legacy summary contributes epoch 1; malformed boundary must be ignored.
      expect(appendedEntry?.metadata?.compactionEpoch).toBe(2);
    } finally {
      await env.orpc.workspace.remove({ workspaceId });
    }
  }, 30000);

  describe("openInEditor", () => {
    it("should return error when editor command not found", async () => {
      const branchName = generateBranchName("plan-open-test");
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      expect(createResult.success).toBe(true);
      if (!createResult.success) throw new Error("Failed to create workspace");

      const workspaceId = createResult.metadata.id;
      const workspaceName = createResult.metadata.name;
      const projectName = createResult.metadata.projectName;

      try {
        // Create a plan file
        const planPath = getPlanFilePath(workspaceName, projectName);
        const planDir = path.dirname(planPath);
        await fs.mkdir(planDir, { recursive: true });
        await fs.writeFile(planPath, "# Test Plan");

        // Try to open with a non-existent custom editor
        const result = await env.orpc.general.openInEditor({
          workspaceId,
          targetPath: planPath,
          editorConfig: {
            editor: "custom",
            customCommand: "nonexistent-editor-command-12345",
          },
        });

        // Should return error since editor command doesn't exist
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("not found");
        }
      } finally {
        await env.orpc.workspace.remove({ workspaceId });
      }
    }, 30000);

    it("should return error when workspace not found", async () => {
      // Note: Built-in editors (vscode/cursor/zed) are now opened via deep links
      // on the frontend, so the backend API only handles custom editors.
      const result = await env.orpc.general.openInEditor({
        workspaceId: "nonexistent-workspace-id",
        targetPath: "/some/path",
        editorConfig: {
          editor: "custom",
          customCommand: "code",
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not found");
      }
    }, 30000);
  });
});
