import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createFileReadTool } from "./file_read";
import type { FileReadToolArgs, FileReadToolResult } from "@/common/types/tools";
import type { ToolExecutionOptions } from "ai";
import { TestTempDir, createTestToolConfig, getTestDeps } from "./testHelpers";

// Mock ToolCallOptions for testing
const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

// Helper to create file_read tool with test configuration
// Returns both tool and disposable temp directory
function createTestFileReadTool(options?: { cwd?: string }) {
  const tempDir = new TestTempDir("test-file-read");
  const config = createTestToolConfig(options?.cwd ?? process.cwd());
  config.runtimeTempDir = tempDir.path; // Override runtimeTempDir to use test's disposable temp dir
  const tool = createFileReadTool(config);

  return {
    tool,
    runtimeTempDir: tempDir.path,
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

class RecordingDevcontainerRuntime extends DevcontainerRuntime {
  readPaths: string[] = [];

  override stat(): Promise<{ size: number; modifiedTime: Date; isDirectory: boolean }> {
    return Promise.resolve({ size: 5, modifiedTime: new Date(), isDirectory: false });
  }

  override readFile(filePath: string): ReadableStream<Uint8Array> {
    this.readPaths.push(filePath);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("plan\n"));
        controller.close();
      },
    });
  }
}

describe("file_read tool", () => {
  let testDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "fileRead-test-"));
    testFilePath = path.join(testDir, "test.txt");
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("reads tilde paths from the Dev Container user's home", async () => {
    const planPath = "~/.mux/plans/test-project/devcontainer-plan.md";
    const runtime = new RecordingDevcontainerRuntime({
      srcBaseDir: "/tmp/mux",
      configPath: ".devcontainer/devcontainer.json",
    });
    const runtimeState = runtime as unknown as { remoteUser?: string };
    runtimeState.remoteUser = "node";

    const tool = createFileReadTool({
      ...getTestDeps(),
      cwd: "/workspace/project",
      runtime,
      runtimeTempDir: "/tmp",
    });

    const result = (await tool.execute!(
      { path: planPath },
      mockToolCallOptions
    )) as FileReadToolResult;

    expect(result.success).toBe(true);
    expect(runtime.readPaths).toEqual(["/home/node/.mux/plans/test-project/devcontainer-plan.md"]);
  });

  it("should read entire file with line numbers", async () => {
    // Setup
    const content = "line one\nline two\nline three";
    await fs.writeFile(testFilePath, content);

    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: "test.txt", // Use relative path
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lines_read).toBe(3);
      expect(result.content).toBe("1\tline one\n2\tline two\n3\tline three");
      expect(result.file_size).toBeGreaterThan(0);
    }
  });

  it("should read file with offset", async () => {
    // Setup
    const content = "line1\nline2\nline3\nline4\nline5";
    await fs.writeFile(testFilePath, content);

    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: "test.txt", // Use relative path
      offset: 3, // Start from line 3
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lines_read).toBe(3);
      expect(result.content).toBe("3\tline3\n4\tline4\n5\tline5");
    }
  });

  it("should read file with limit", async () => {
    // Setup
    const content = "line1\nline2\nline3\nline4\nline5";
    await fs.writeFile(testFilePath, content);

    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: "test.txt", // Use relative path
      limit: 2, // Read only first 2 lines
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lines_read).toBe(2);
      expect(result.content).toBe("1\tline1\n2\tline2");
    }
  });

  it("should read file with offset and limit", async () => {
    // Setup
    const content = "line1\nline2\nline3\nline4\nline5";
    await fs.writeFile(testFilePath, content);

    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: "test.txt", // Use relative path
      offset: 2, // Start from line 2
      limit: 2, // Read 2 lines
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lines_read).toBe(2);
      expect(result.content).toBe("2\tline2\n3\tline3");
    }
  });

  it("should handle single line file", async () => {
    // Setup
    const content = "single line";
    await fs.writeFile(testFilePath, content);

    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: "test.txt", // Use relative path
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lines_read).toBe(1);
      expect(result.content).toBe("1\tsingle line");
    }
  });

  it("should handle empty file", async () => {
    // Setup
    await fs.writeFile(testFilePath, "");

    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: "test.txt", // Use relative path
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lines_read).toBe(0);
      expect(result.content).toBe("");
    }
  });

  it("should fail when file does not exist", async () => {
    // Setup
    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: "nonexistent.txt", // Use relative path
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/File not found|Failed to stat.*ENOENT/);
    }
  });

  it("should fail when offset is invalid", async () => {
    // Setup
    const content = "line1\nline2";
    await fs.writeFile(testFilePath, content);

    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: "test.txt", // Use relative path
      offset: 10, // Beyond file length
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("beyond file length");
    }
  });

  it("should truncate lines longer than 1024 bytes", async () => {
    // Setup - create a line with more than 1024 bytes
    const longLine = "x".repeat(2000);
    const content = `short line\n${longLine}\nanother short line`;
    await fs.writeFile(testFilePath, content);

    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: "test.txt", // Use relative path
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lines_read).toBe(3);
      const lines = result.content.split("\n");
      expect(lines[0]).toBe("1\tshort line");
      expect(lines[1]).toContain("... [truncated]");
      expect(Buffer.byteLength(lines[1], "utf-8")).toBeLessThan(1100); // Should be around 1024 + prefix + truncation marker
      expect(lines[2]).toBe("3\tanother short line");
    }
  });

  it("should fail when reading more than 1000 lines", async () => {
    // Setup - create a file with 1001 lines
    const lines = Array.from({ length: 1001 }, (_, i) => `line${i + 1}`);
    const content = lines.join("\n");
    await fs.writeFile(testFilePath, content);

    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: "test.txt", // Use relative path
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("1000 lines");
      expect(result.error).toContain("read less at a time");
    }
  });

  it("should fail when total output exceeds 16KB", async () => {
    // Setup - create lines that together exceed 16KB
    // Each line is about 200 bytes, so 100 lines will exceed 16KB
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}:${"x".repeat(200)}`);
    const content = lines.join("\n");
    await fs.writeFile(testFilePath, content);

    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: "test.txt", // Use relative path
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("16384 bytes");
      expect(result.error).toContain("read less at a time");
    }
  });

  it("should allow reading with limit to stay under 1000 lines", async () => {
    // Setup - create a file with 1001 lines
    const lines = Array.from({ length: 1001 }, (_, i) => `line${i + 1}`);
    const content = lines.join("\n");
    await fs.writeFile(testFilePath, content);

    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: "test.txt", // Use relative path
      limit: 500, // Read only 500 lines
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.lines_read).toBe(500);
    }
  });

  it("should auto-correct absolute paths containing the workspace directory", async () => {
    // Setup
    const content = "test content";
    await fs.writeFile(testFilePath, content);

    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: testFilePath, // Absolute path containing cwd prefix
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert - Should succeed with auto-correction warning
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.warning).toContain("auto-corrected");
      expect(result.warning).toContain("test.txt"); // Should mention the relative path
      expect(result.content).toContain("test content");
    }
  });

  it("should allow reading files with relative paths within cwd", async () => {
    // Setup - create a subdirectory and file
    const subDir = path.join(testDir, "subdir");
    await fs.mkdir(subDir);
    const subFilePath = path.join(subDir, "test.txt");
    const content = "content in subdir";
    await fs.writeFile(subFilePath, content);

    // Read using relative path from cwd
    using testEnv = createTestFileReadTool({ cwd: testDir });
    const tool = testEnv.tool;
    const args: FileReadToolArgs = {
      path: "subdir/test.txt",
    };

    // Execute
    const result = (await tool.execute!(args, mockToolCallOptions)) as FileReadToolResult;

    // Assert
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toContain("content in subdir");
    }
  });

  async function expectReadAllowedOutsideCwd(
    targetPath: string,
    expectedContent: string
  ): Promise<void> {
    const tool = createFileReadTool({
      ...getTestDeps(),
      cwd: testDir,
      runtime: new LocalRuntime(testDir),
      runtimeTempDir: testDir,
    });

    const result = (await tool.execute!(
      { path: targetPath },
      mockToolCallOptions
    )) as FileReadToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toBe(expectedContent);
    }
  }

  it("should allow traversal outside cwd", async () => {
    const outsideDir = path.join(path.dirname(testDir), `${path.basename(testDir)}-outside`);
    const targetPath = path.join(outsideDir, "outside.txt");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(targetPath, "outside");

    try {
      await expectReadAllowedOutsideCwd(
        `../${path.basename(outsideDir)}/outside.txt`,
        "1\toutside"
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("should allow absolute paths outside cwd", async () => {
    const outsideDir = path.join(path.dirname(testDir), `${path.basename(testDir)}-outside-abs`);
    const targetPath = path.join(outsideDir, "outside.txt");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(targetPath, "outside");

    try {
      await expectReadAllowedOutsideCwd(targetPath, "1\toutside");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("should allow reading the exact configured plan file outside cwd outside plan mode", async () => {
    const planDir = await fs.mkdtemp(path.join(os.tmpdir(), "planFile-exec-read-"));
    const planPath = path.join(planDir, "plan.md");

    try {
      const planContent = "# Plan\n\n- Step 1";
      await fs.writeFile(planPath, planContent);

      const tool = createFileReadTool({
        ...getTestDeps(),
        cwd: testDir,
        runtime: new LocalRuntime(testDir),
        runtimeTempDir: testDir,
        planFilePath: planPath,
      });

      const result = (await tool.execute!(
        { path: planPath },
        mockToolCallOptions
      )) as FileReadToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("1\t# Plan\n2\t\n3\t- Step 1");
      }
    } finally {
      await fs.rm(planDir, { recursive: true, force: true });
    }
  });

  it("should allow reading an ancestor plan file outside cwd without an explicit allowlist", async () => {
    const planDir = await fs.mkdtemp(path.join(os.tmpdir(), "ancestor-plan-read-"));
    const ancestorPlanPath = path.join(planDir, "ancestor.md");

    try {
      await fs.writeFile(ancestorPlanPath, "# Ancestor Plan\n\n- Context");

      const tool = createFileReadTool({
        ...getTestDeps(),
        cwd: testDir,
        runtime: new LocalRuntime(testDir),
        runtimeTempDir: testDir,
      });

      const result = (await tool.execute!(
        { path: ancestorPlanPath },
        mockToolCallOptions
      )) as FileReadToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("1\t# Ancestor Plan\n2\t\n3\t- Context");
      }
    } finally {
      await fs.rm(planDir, { recursive: true, force: true });
    }
  });

  it("should allow unrelated outside-cwd reads when ancestor plan paths are configured", async () => {
    const planDir = await fs.mkdtemp(path.join(os.tmpdir(), "ancestor-plan-other-read-"));
    const ancestorPlanPath = path.join(planDir, "ancestor.md");
    const otherPath = path.join(planDir, "other.md");

    try {
      await fs.writeFile(ancestorPlanPath, "# Ancestor Plan\n");
      await fs.writeFile(otherPath, "# Other\n");

      const tool = createFileReadTool({
        ...getTestDeps(),
        cwd: testDir,
        runtime: new LocalRuntime(testDir),
        runtimeTempDir: testDir,
        ancestorPlanFilePaths: [ancestorPlanPath],
      });

      const result = (await tool.execute!(
        { path: otherPath },
        mockToolCallOptions
      )) as FileReadToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("1\t# Other\n2\t");
      }
    } finally {
      await fs.rm(planDir, { recursive: true, force: true });
    }
  });

  it("should allow other outside-cwd reads when planFilePath is configured", async () => {
    const planDir = await fs.mkdtemp(path.join(os.tmpdir(), "planFile-other-read-"));
    const planPath = path.join(planDir, "plan.md");
    const otherPath = path.join(planDir, "other.md");

    try {
      await fs.writeFile(planPath, "# Plan\n");
      await fs.writeFile(otherPath, "# Other\n");

      const tool = createFileReadTool({
        ...getTestDeps(),
        cwd: testDir,
        runtime: new LocalRuntime(testDir),
        runtimeTempDir: testDir,
        planFilePath: planPath,
      });

      const result = (await tool.execute!(
        { path: otherPath },
        mockToolCallOptions
      )) as FileReadToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("1\t# Other\n2\t");
      }
    } finally {
      await fs.rm(planDir, { recursive: true, force: true });
    }
  });
});
