import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createFileEditInsertTool } from "./file_edit_insert";
import type { FileEditInsertToolArgs, FileEditInsertToolResult } from "@/common/types/tools";
import type { ToolExecutionOptions } from "ai";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { DevcontainerRuntime } from "@/node/runtime/DevcontainerRuntime";
import { getTestDeps } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

function createTestTool(cwd: string) {
  return createFileEditInsertTool({
    ...getTestDeps(),
    cwd,
    runtime: createRuntime({ type: "local", srcBaseDir: cwd }),
    runtimeTempDir: cwd,
  });
}

describe("file_edit_insert tool", () => {
  let testDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-edit-insert-"));
    testFilePath = path.join(testDir, "test.txt");
    await fs.writeFile(testFilePath, "Line 1\nLine 3");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("inserts content using insert_after guard", async () => {
    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      path: path.relative(testDir, testFilePath),
      content: "Line 2\n",
      insert_after: "Line 1\n",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;

    expect(result.success).toBe(true);
    const updated = await fs.readFile(testFilePath, "utf-8");
    expect(updated).toBe("Line 1\nLine 2\nLine 3");
  });

  it("inserts content using insert_after guard when file uses CRLF", async () => {
    await fs.writeFile(testFilePath, "Line 1\r\nLine 3\r\n");

    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      path: path.relative(testDir, testFilePath),
      content: "Line 2\n",
      insert_after: "Line 1\n",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;

    expect(result.success).toBe(true);
    const updated = await fs.readFile(testFilePath, "utf-8");
    expect(updated).toBe("Line 1\r\nLine 2\r\nLine 3\r\n");
  });

  it("inserts content using insert_before guard", async () => {
    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      path: path.relative(testDir, testFilePath),
      content: "Header\n",
      insert_before: "Line 1",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;
    expect(result.success).toBe(true);
    expect(await fs.readFile(testFilePath, "utf-8")).toBe("Header\nLine 1\nLine 3");
  });

  it("fails when guard matches multiple times", async () => {
    await fs.writeFile(testFilePath, "repeat\nrepeat\nrepeat\n");
    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      path: path.relative(testDir, testFilePath),
      content: "middle\n",
      insert_after: "repeat\n",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("multiple times");
    }
  });

  it("fails when guard is not found and does not modify the file", async () => {
    const original = await fs.readFile(testFilePath, "utf-8");

    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      path: path.relative(testDir, testFilePath),
      content: "Line 2\n",
      insert_after: "does not exist\n",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;

    expect(result.success).toBe(false);
    expect(await fs.readFile(testFilePath, "utf-8")).toBe(original);
  });

  it("fails when both insert_before and insert_after are provided", async () => {
    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      path: path.relative(testDir, testFilePath),
      content: "oops",
      insert_after: "Line 1",
      insert_before: "Line 3",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("only one of insert_before or insert_after");
    }
  });

  it("creates a new file without requiring create flag or guards", async () => {
    const newFile = path.join(testDir, "new.txt");
    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      path: path.relative(testDir, newFile),
      content: "Hello world!\n",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;
    expect(result.success).toBe(true);
    expect(await fs.readFile(newFile, "utf-8")).toBe("Hello world!\n");
  });

  it("populates an empty existing file without requiring guards", async () => {
    const emptyFile = path.join(testDir, "empty.txt");
    await fs.writeFile(emptyFile, "");
    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      path: path.relative(testDir, emptyFile),
      content: "Hello empty!\n",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;
    expect(result.success).toBe(true);
    expect(await fs.readFile(emptyFile, "utf-8")).toBe("Hello empty!\n");
  });

  it("fails when no guards are provided", async () => {
    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      path: path.relative(testDir, testFilePath),
      content: "noop",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Provide either insert_before or insert_after guard");
    }
  });
});

class RecordingDevcontainerRuntime extends DevcontainerRuntime {
  writtenPaths: string[] = [];

  override stat(): Promise<never> {
    return Promise.reject(new Error("file does not exist"));
  }

  override writeFile(filePath: string): WritableStream<Uint8Array> {
    this.writtenPaths.push(filePath);
    return new WritableStream<Uint8Array>();
  }
}

it("creates plan files in the Dev Container user's home", async () => {
  const planPath = "~/.mux/plans/test-project/devcontainer-plan.md";
  const runtime = new RecordingDevcontainerRuntime({
    srcBaseDir: "/tmp/mux",
    configPath: ".devcontainer/devcontainer.json",
  });
  const runtimeState = runtime as unknown as { remoteUser?: string };
  runtimeState.remoteUser = "node";

  const tool = createFileEditInsertTool({
    ...getTestDeps(),
    cwd: "/workspace/project",
    runtime,
    runtimeTempDir: "/tmp",
    planFileOnly: true,
    planFilePath: planPath,
  });

  const result = (await tool.execute!(
    { path: planPath, content: "# Plan\n" },
    mockToolCallOptions
  )) as FileEditInsertToolResult;

  expect(result.success).toBe(true);
  expect(runtime.writtenPaths).toEqual(["/home/node/.mux/plans/test-project/devcontainer-plan.md"]);
  expect(runtime.writtenPaths).not.toContain(
    "/home/host-user/.mux/plans/test-project/devcontainer-plan.md"
  );
});

describe("file_edit_insert outside-cwd access", () => {
  it("allows traversal outside cwd", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-edit-insert-outside-"));
    const workspaceCwd = path.join(rootDir, "workspace");
    const outsideDir = path.join(rootDir, "outside");
    const outsidePath = path.join(outsideDir, "outside.txt");

    await fs.mkdir(workspaceCwd, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    try {
      const tool = createFileEditInsertTool({
        ...getTestDeps(),
        cwd: workspaceCwd,
        runtime: createRuntime({ type: "local", srcBaseDir: workspaceCwd }),
        runtimeTempDir: rootDir,
      });

      const result = (await tool.execute!(
        {
          path: "../outside/outside.txt",
          content: "created",
        },
        mockToolCallOptions
      )) as FileEditInsertToolResult;

      expect(result.success).toBe(true);
      expect(await fs.readFile(outsidePath, "utf-8")).toBe("created");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("allows absolute paths outside cwd", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-edit-insert-outside-abs-"));
    const workspaceCwd = path.join(rootDir, "workspace");
    const outsideDir = path.join(rootDir, "outside");
    const outsidePath = path.join(outsideDir, "outside.txt");

    await fs.mkdir(workspaceCwd, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    try {
      const tool = createFileEditInsertTool({
        ...getTestDeps(),
        cwd: workspaceCwd,
        runtime: createRuntime({ type: "local", srcBaseDir: workspaceCwd }),
        runtimeTempDir: rootDir,
      });

      const result = (await tool.execute!(
        {
          path: outsidePath,
          content: "created",
        },
        mockToolCallOptions
      )) as FileEditInsertToolResult;

      expect(result.success).toBe(true);
      expect(await fs.readFile(outsidePath, "utf-8")).toBe("created");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe("file_edit_insert plan mode enforcement", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-mode-insert-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("blocks creating non-plan files when in plan mode", async () => {
    const planFilePath = path.join(testDir, "sessions", "workspace", "plan.md");
    const otherFilePath = path.join(testDir, "workspace", "main.ts");
    const workspaceCwd = path.join(testDir, "workspace");

    // Create workspace directory
    await fs.mkdir(workspaceCwd, { recursive: true });

    const tool = createFileEditInsertTool({
      ...getTestDeps(),
      cwd: workspaceCwd,
      runtime: createRuntime({ type: "local", srcBaseDir: workspaceCwd }),
      runtimeTempDir: testDir,
      planFileOnly: true,
      planFilePath: planFilePath,
    });

    const args: FileEditInsertToolArgs = {
      path: otherFilePath,
      content: "console.log('test');",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("In the plan agent, only the plan file can be edited");
    }
  });

  it("allows creating the configured plan file when it is outside cwd", async () => {
    const planFilePath = path.join(testDir, "plan.md");
    const workspaceCwd = path.join(testDir, "workspace");

    await fs.mkdir(workspaceCwd, { recursive: true });

    const tool = createFileEditInsertTool({
      ...getTestDeps(),
      cwd: workspaceCwd,
      runtime: createRuntime({ type: "local", srcBaseDir: workspaceCwd }),
      runtimeTempDir: testDir,
      planFileOnly: true,
      planFilePath: planFilePath,
    });

    const args: FileEditInsertToolArgs = {
      path: planFilePath,
      content: "# My Plan\n\n- Step 1\n- Step 2\n",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;

    expect(result.success).toBe(true);
    expect(await fs.readFile(planFilePath, "utf-8")).toBe("# My Plan\n\n- Step 1\n- Step 2\n");
  });

  it("allows creating the configured plan file when it is outside cwd outside plan mode", async () => {
    const planFilePath = path.join(testDir, "plan.md");
    const workspaceCwd = path.join(testDir, "workspace");

    await fs.mkdir(workspaceCwd, { recursive: true });

    const tool = createFileEditInsertTool({
      ...getTestDeps(),
      cwd: workspaceCwd,
      runtime: createRuntime({ type: "local", srcBaseDir: workspaceCwd }),
      runtimeTempDir: testDir,
      planFilePath,
    });

    const args: FileEditInsertToolArgs = {
      path: planFilePath,
      content: "# Exec Plan\n\n- Step 1\n",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;

    expect(result.success).toBe(true);
    expect(await fs.readFile(planFilePath, "utf-8")).toBe("# Exec Plan\n\n- Step 1\n");
  });

  it("allows editing any file in exec mode", async () => {
    const testFilePath = path.join(testDir, "main.ts");
    await fs.writeFile(testFilePath, "const x = 1;");

    const tool = createFileEditInsertTool({
      ...getTestDeps(),
      cwd: testDir,
      runtime: createRuntime({ type: "local", srcBaseDir: testDir }),
      runtimeTempDir: testDir,
    });

    const args: FileEditInsertToolArgs = {
      path: testFilePath,
      content: "// header\n",
      insert_before: "const x = 1;",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;

    expect(result.success).toBe(true);
    expect(await fs.readFile(testFilePath, "utf-8")).toBe("// header\nconst x = 1;");
  });

  it("blocks creating .mux/plan.md (wrong path) when real plan file is elsewhere", async () => {
    // This test simulates the bug where an agent tries to create ".mux/plan.md"
    // in the workspace instead of using the actual plan file at ~/.mux/plans/project/workspace.md
    const workspaceCwd = path.join(testDir, "workspace");
    const wrongPlanPath = path.join(workspaceCwd, ".mux", "plan.md");
    const realPlanPath = path.join(testDir, "plans", "project", "workspace.md");

    // Create workspace directory (simulate a real project workspace)
    await fs.mkdir(workspaceCwd, { recursive: true });
    // Create the plans directory structure
    await fs.mkdir(path.dirname(realPlanPath), { recursive: true });

    const tool = createFileEditInsertTool({
      ...getTestDeps(),
      cwd: workspaceCwd,
      runtime: createRuntime({ type: "local", srcBaseDir: workspaceCwd }),
      runtimeTempDir: testDir,
      planFileOnly: true,
      planFilePath: realPlanPath, // The REAL plan file path
    });

    // Agent mistakenly tries to create ".mux/plan.md" in workspace
    const args: FileEditInsertToolArgs = {
      path: ".mux/plan.md", // Wrong path - relative to cwd
      content: "# My Plan\n\n- Step 1\n",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("In the plan agent, only the plan file can be edited");
      expect(result.error).toContain("exact plan file path");
      expect(result.error).toContain(realPlanPath);
      expect(result.error).toContain(".mux/plan.md");
    }

    // Ensure the wrong file was NOT created
    const wrongFileExists = await fs
      .stat(wrongPlanPath)
      .then(() => true)
      .catch(() => false);
    expect(wrongFileExists).toBe(false);
  });
});
