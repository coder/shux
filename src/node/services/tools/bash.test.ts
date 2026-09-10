import { describe, it, expect } from "bun:test";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { ExecOptions, ExecStream, Runtime } from "@/node/runtime/Runtime";
import { buildBashToolDescription, createBashTool } from "./bash";
import type { BashOutputEvent } from "@/common/types/stream";
import type { ProjectRef } from "@/common/types/workspace";
import type { BashToolArgs, BashToolResult } from "@/common/types/tools";
import { BASH_MAX_TOTAL_BYTES } from "@/common/constants/toolLimits";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import * as path from "path";
import * as fs from "fs";
import { TestTempDir, createTestToolConfig, getTestDeps, mockToolCallOptions } from "./testHelpers";
import type { createRuntime as CreateRuntimeFn } from "@/node/runtime/runtimeFactory";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
const {
  createRuntime,
}: { createRuntime: typeof CreateRuntimeFn } = require("@/node/runtime/runtimeFactory?real=1");
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment */
import { sshConnectionPool } from "@/node/runtime/sshConnectionPool";

// Type guard to narrow foreground success result (has note, no backgroundProcessId)
function isForegroundSuccess(
  result: BashToolResult
): result is BashToolResult & { success: true; note?: string } {
  return result.success && !("backgroundProcessId" in result);
}

import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";

// Helper to create bash tool with test configuration
// Returns both tool and disposable temp directory
// Use with: using testEnv = createTestBashTool();
function createExecStream(stdout: string, exitCode = 0): ExecStream {
  const encoder = new TextEncoder();
  return {
    stdout: new ReadableStream({
      start(controller) {
        if (stdout.length > 0) controller.enqueue(encoder.encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    stdin: new WritableStream(),
    exitCode: Promise.resolve(exitCode),
    duration: Promise.resolve(0),
  };
}

function createTestBashTool() {
  const tempDir = new TestTempDir("test-bash");
  const config = createTestToolConfig(process.cwd());
  config.runtimeTempDir = tempDir.path; // Override runtimeTempDir to use test's disposable temp dir
  const tool = createBashTool(config);

  return {
    tool,
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

describe("buildBashToolDescription", () => {
  const cwd = "/workspace/root";
  const multiProjectRefs: ProjectRef[] = [
    { projectName: "frontend", projectPath: "/workspace/root/frontend" },
    { projectName: "backend", projectPath: "/workspace/root/backend" },
  ];

  it("returns standard description for single-project workspaces", () => {
    const noProjectsDescription = buildBashToolDescription(cwd, []);
    const oneProjectDescription = buildBashToolDescription(cwd, [multiProjectRefs[0]]);

    expect(noProjectsDescription).toContain(TOOL_DEFINITIONS.bash.description);
    expect(noProjectsDescription).toContain(`Runs in ${cwd} - no cd needed`);
    expect(noProjectsDescription).not.toContain("independent git repo");

    expect(oneProjectDescription).toContain(TOOL_DEFINITIONS.bash.description);
    expect(oneProjectDescription).toContain(`Runs in ${cwd} - no cd needed`);
    expect(oneProjectDescription).not.toContain("independent git repo");
  });

  it("includes project listing for multi-project workspaces", () => {
    const description = buildBashToolDescription(cwd, multiProjectRefs);

    expect(description).toContain(`Runs in ${cwd} — a multi-project workspace containing:`);
    expect(description).toContain("  - frontend/ → /workspace/root/frontend");
    expect(description).toContain("  - backend/ → /workspace/root/backend");
    expect(description).toContain("independent git repo");
  });

  it("includes project paths for multi-project workspaces", () => {
    const description = buildBashToolDescription(cwd, multiProjectRefs);

    for (const projectRef of multiProjectRefs) {
      expect(description).toContain(projectRef.projectPath);
    }
  });
});

describe("bash tool", () => {
  it("should execute a simple command successfully", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      script: "echo hello",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe("hello");
      expect(result.exitCode).toBe(0);
    }
  });

  it("should emit bash-output events when emitChatEvent is provided", async () => {
    const tempDir = new TestTempDir("test-bash-live-output");
    const events: BashOutputEvent[] = [];

    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.emitChatEvent = (event) => {
      if (event.type === "bash-output") {
        events.push(event);
      }
    };

    const tool = createBashTool(config);

    const args: BashToolArgs = {
      script: "echo out && echo err 1>&2",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;
    expect(result.success).toBe(true);

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.workspaceId === config.workspaceId)).toBe(true);
    expect(events.every((e) => e.toolCallId === mockToolCallOptions.toolCallId)).toBe(true);

    const stdoutText = events
      .filter((e) => !e.isError)
      .map((e) => e.text)
      .join("");
    const stderrText = events
      .filter((e) => e.isError)
      .map((e) => e.text)
      .join("");

    expect(stdoutText).toContain("out");
    expect(stderrText).toContain("err");

    tempDir[Symbol.dispose]();
  });

  it("should handle multi-line output", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      script: "echo line1 && echo line2 && echo line3",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe("line1\nline2\nline3");
    }
  });

  it("should warn when using cat to read a file", async () => {
    using tempDir = new TestTempDir("test-bash-cat-read");

    const filePath = path.join(tempDir.path, "input.txt");
    fs.writeFileSync(filePath, "hello\nworld", "utf-8");

    const config = createTestToolConfig(tempDir.path);
    config.runtimeTempDir = tempDir.path;
    const tool = createBashTool(config);

    const args: BashToolArgs = {
      script: `cat ${filePath}`,
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      expect(result.output).toBe("hello\nworld");
      expect(result.note).toContain("DO NOT use `cat`");
      expect(result.note).toContain("file_read");
    }
  });

  it("should not warn on cat heredoc", async () => {
    using tempDir = new TestTempDir("test-bash-cat-heredoc");

    const config = createTestToolConfig(tempDir.path);
    config.runtimeTempDir = tempDir.path;
    const tool = createBashTool(config);

    const args: BashToolArgs = {
      script: "cat <<'EOF'\nhello\nEOF",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      expect(result.output).toBe("hello");
      expect(result.note).toBeUndefined();
    }
  });

  it("should warn when using grep to dump a file", async () => {
    using tempDir = new TestTempDir("test-bash-grep-read");

    const filePath = path.join(tempDir.path, "input.txt");
    fs.writeFileSync(filePath, "hello\nworld", "utf-8");

    const config = createTestToolConfig(tempDir.path);
    config.runtimeTempDir = tempDir.path;
    const tool = createBashTool(config);

    const args: BashToolArgs = {
      script: `grep '' ${filePath}`,
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      expect(result.output).toBe("hello\nworld");
      expect(result.note).toContain("file_read");
      expect(result.note).toContain("`grep`");
    }
  });

  it("should not warn on grep search", async () => {
    using tempDir = new TestTempDir("test-bash-grep-search");

    const filePath = path.join(tempDir.path, "input.txt");
    fs.writeFileSync(filePath, "hello\nworld", "utf-8");

    const config = createTestToolConfig(tempDir.path);
    config.runtimeTempDir = tempDir.path;
    const tool = createBashTool(config);

    const args: BashToolArgs = {
      script: `grep 'hello' ${filePath}`,
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      expect(result.output).toBe("hello");
      expect(result.note).toBeUndefined();
    }
  });

  it("should warn when using rg to dump a file", async () => {
    using tempDir = new TestTempDir("test-bash-rg-read");

    const filePath = path.join(tempDir.path, "input.txt");
    fs.writeFileSync(filePath, "hello\nworld", "utf-8");

    const config = createTestToolConfig(tempDir.path);
    config.runtimeTempDir = tempDir.path;
    const tool = createBashTool(config);

    // CI images don’t guarantee ripgrep is installed; shim `rg` so we can exercise the
    // bash-tool warning heuristics without depending on the real binary.
    const args: BashToolArgs = {
      script: `rg() { grep -E "$1" "$2"; }\nrg '' "${filePath}"`,
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      expect(result.output).toBe("hello\nworld");
      expect(result.note).toContain("file_read");
      expect(result.note).toContain("`rg`");
    }
  });

  it("should not warn on rg search", async () => {
    using tempDir = new TestTempDir("test-bash-rg-search");

    const filePath = path.join(tempDir.path, "input.txt");
    fs.writeFileSync(filePath, "hello\nworld", "utf-8");

    const config = createTestToolConfig(tempDir.path);
    config.runtimeTempDir = tempDir.path;
    const tool = createBashTool(config);

    // CI images don’t guarantee ripgrep is installed; shim `rg` so we can exercise the
    // bash-tool warning heuristics without depending on the real binary.
    const args: BashToolArgs = {
      script: `rg() { grep -E "$1" "$2"; }\nrg 'hello' "${filePath}"`,
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      expect(result.output).toBe("hello");
      expect(result.note).toBeUndefined();
    }
  });
  it("should warn on cat file reads even when output overflows", async () => {
    using tempDir = new TestTempDir("test-bash-cat-overflow");

    const filePath = path.join(tempDir.path, "large.txt");
    fs.writeFileSync(
      filePath,
      Array.from({ length: 400 }, (_, i) => `line${i + 1}`).join("\n"),
      "utf-8"
    );

    const config = createTestToolConfig(tempDir.path);
    config.runtimeTempDir = tempDir.path;
    const tool = createBashTool(config);

    const args: BashToolArgs = {
      script: `cat ${filePath}`,
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      expect(result.output).toBe("");
      expect(result.note).toContain("DO NOT use `cat`");
      expect(result.note).toContain("[OUTPUT OVERFLOW");

      const match = /saved to (\/.*?\.txt)/.exec(result.note ?? "");
      expect(match).toBeDefined();
      if (match) {
        const overflowPath = match[1];
        expect(fs.existsSync(overflowPath)).toBe(true);
        fs.unlinkSync(overflowPath);
      }
    }
  });

  it("should report overflow when hard cap (300 lines) is exceeded", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      run_in_background: false,
      script: "for i in {1..400}; do echo line$i; done", // Exceeds 300 line hard cap
      timeout_secs: 5,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      expect(result.output).toBe("");
      expect(result.note).toContain("[OUTPUT OVERFLOW");
      expect(result.note).toContain("Line count exceeded");
      expect(result.note).toContain("300 lines");
      expect(result.exitCode).toBe(0);
    }
  });

  it("should save overflow output to temp file with short ID", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      run_in_background: false,
      script: "for i in {1..400}; do echo line$i; done", // Exceeds 300 line hard cap
      timeout_secs: 5,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      expect(result.output).toBe("");
      expect(result.note).toContain("[OUTPUT OVERFLOW");
      // Should contain specific overflow reason (one of the three types)
      expect(result.note).toMatch(
        /Line count exceeded|Total output exceeded|exceeded per-line limit/
      );
      expect(result.note).toContain("Full output");
      expect(result.note).toContain("lines) saved to");
      expect(result.note).toContain("bash-");
      expect(result.note).toContain(".txt");
      expect(result.note).toContain("File will be automatically cleaned up when stream ends");
      expect(result.exitCode).toBe(0);

      // Extract file path from output message (handles both "lines saved to" and "lines) saved to")
      const match = /saved to (\/.+?\.txt)/.exec(result.note ?? "");
      expect(match).toBeDefined();
      if (match) {
        const overflowPath = match[1];

        // Verify file has short ID format (bash-<8 hex chars>.txt)
        const filename = overflowPath.split("/").pop();
        expect(filename).toMatch(/^bash-[0-9a-f]{8}\.txt$/);

        // Verify file exists and read contents
        expect(fs.existsSync(overflowPath)).toBe(true);

        // Verify file contains collected lines (at least 300, may be slightly more)
        const fileContent = fs.readFileSync(overflowPath, "utf-8");
        const fileLines = fileContent.split("\n").filter((l: string) => l.length > 0);
        expect(fileLines.length).toBeGreaterThanOrEqual(300);
        expect(fileContent).toContain("line1");
        expect(fileContent).toContain("line300");

        // Clean up temp file
        fs.unlinkSync(overflowPath);
      }
    }
  });

  it("should report overflow quickly when hard cap is reached", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const startTime = performance.now();

    const args: BashToolArgs = {
      // This will generate 500 lines quickly - should report overflow at 300
      run_in_background: false,
      script: "for i in {1..500}; do echo line$i; done",
      timeout_secs: 5,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;
    const duration = performance.now() - startTime;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      // Should complete quickly since we stop at 300 lines
      expect(duration).toBeLessThan(4000);
      expect(result.output).toBe("");
      expect(result.note).toContain("[OUTPUT OVERFLOW");
      expect(result.note).toContain("Line count exceeded");
      expect(result.note).toContain("300 lines");
      expect(result.exitCode).toBe(0);
    }
  });

  it("should truncate overflow output when overflow_policy is 'truncate'", async () => {
    const tempDir = new TestTempDir("test-bash-truncate");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.overflow_policy = "truncate";
    const tool = createBashTool(config);

    const args: BashToolArgs = {
      // Generate ~1.5MB of output (1700 lines * 900 bytes) to exceed 1MB byte limit
      script: 'perl -e \'for (1..1700) { print "A" x 900 . "\\n" }\'',
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    // With truncate policy and overflow, should succeed with truncated field
    expect(result.success).toBe(true);
    if (result.success && "truncated" in result) {
      expect(result.truncated).toBeDefined();
      if (result.truncated) {
        expect(result.truncated.reason).toContain("exceed");
        // Should collect lines up to ~1MB (around 1150-1170 lines with 900 bytes each)
        expect(result.truncated.totalLines).toBeGreaterThan(1000);
        expect(result.truncated.totalLines).toBeLessThan(1300);
      }
    }

    // Should contain output that's around 1MB
    expect(result.output?.length).toBeGreaterThan(1000000);
    expect(result.output?.length).toBeLessThan(1100000);

    // Should NOT create temp file with truncate policy
    const files = fs.readdirSync(tempDir.path);
    const bashFiles = files.filter((f) => f.startsWith("bash-"));
    expect(bashFiles.length).toBe(0);

    tempDir[Symbol.dispose]();
  });

  it("should reject single overlong line before storing it (IPC mode)", async () => {
    const tempDir = new TestTempDir("test-bash-overlong-line");
    const tool = createBashTool({
      ...getTestDeps(),
      cwd: process.cwd(),
      runtime: new LocalRuntime(process.cwd()),
      runtimeTempDir: tempDir.path,
      overflow_policy: "truncate",
    });

    const args: BashToolArgs = {
      // Generate a single 2MB line (exceeds 1MB total limit)
      script: 'perl -e \'print "A" x 2000000 . "\\n"\'',
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    // Should succeed but with truncation before storing the overlong line
    expect(result.success).toBe(true);
    if (result.success && "truncated" in result) {
      expect(result.truncated).toBeDefined();
      if (result.truncated) {
        expect(result.truncated.reason).toContain("would exceed file preservation limit");
        // Should have 0 lines collected since the first line was too long
        expect(result.truncated.totalLines).toBe(0);
      }
    }

    // CRITICAL: Output must NOT contain the 2MB line - should be empty or nearly empty
    expect(result.output?.length ?? 0).toBeLessThan(100);

    tempDir[Symbol.dispose]();
  });

  it("should reject overlong line at boundary (IPC mode)", async () => {
    const tempDir = new TestTempDir("test-bash-boundary");
    const tool = createBashTool({
      ...getTestDeps(),
      cwd: process.cwd(),
      runtime: new LocalRuntime(process.cwd()),
      runtimeTempDir: tempDir.path,
      overflow_policy: "truncate",
    });

    const args: BashToolArgs = {
      // First line: 500KB (within limit)
      // Second line: 600KB (would exceed 1MB when added)
      script: 'perl -e \'print "A" x 500000 . "\\n"; print "B" x 600000 . "\\n"\'',
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success && "truncated" in result) {
      expect(result.truncated).toBeDefined();
      if (result.truncated) {
        expect(result.truncated.reason).toContain("would exceed");
        // Should have collected exactly 1 line (the 500KB line)
        expect(result.truncated.totalLines).toBe(1);
      }
    }

    // Output should contain only the first line (~500KB), not the second line
    expect(result.output?.length).toBeGreaterThanOrEqual(500000);
    expect(result.output?.length).toBeLessThan(600000);
    // Verify content is only 'A's, not 'B's
    expect(result.output).toContain("AAAA");
    expect(result.output).not.toContain("BBBB");

    tempDir[Symbol.dispose]();
  });

  it("should use tmpfile policy by default when overflow_policy not specified", async () => {
    const tempDir = new TestTempDir("test-bash-default");
    const tool = createBashTool({
      ...getTestDeps(),
      cwd: process.cwd(),
      runtime: new LocalRuntime(process.cwd()),
      runtimeTempDir: tempDir.path,
      // overflow_policy not specified - should default to tmpfile
    });

    const args: BashToolArgs = {
      run_in_background: false,
      script: "for i in {1..400}; do echo line$i; done",
      timeout_secs: 5,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      // Should use tmpfile behavior
      expect(result.output).toBe("");
      expect(result.note).toContain("[OUTPUT OVERFLOW");
      expect(result.note).toContain("saved to");
      expect(result.note).not.toContain("[OUTPUT TRUNCATED");
      expect(result.exitCode).toBe(0);

      // Verify temp file was created in runtimeTempDir
      expect(fs.existsSync(tempDir.path)).toBe(true);
      const files = fs.readdirSync(tempDir.path);
      const bashFiles = files.filter((f) => f.startsWith("bash-"));
      expect(bashFiles.length).toBe(1);
    }

    tempDir[Symbol.dispose]();
  });

  it("should preserve up to 100KB in temp file even after 16KB display limit", async () => {
    const tempDir = new TestTempDir("test-bash-100kb");
    const tool = createBashTool({
      ...getTestDeps(),
      cwd: process.cwd(),
      runtime: new LocalRuntime(process.cwd()),
      runtimeTempDir: tempDir.path,
    });

    // Generate ~50KB of output (well over 16KB display limit, under 100KB file limit)
    // Each line is ~40 bytes: "line" + number (1-5 digits) + padding = ~40 bytes
    // 50KB / 40 bytes = ~1250 lines
    const args: BashToolArgs = {
      run_in_background: false,
      script: "for i in {1..1300}; do printf 'line%04d with some padding text here\\n' $i; done",
      timeout_secs: 5,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      // Should hit display limit and save to temp file
      expect(result.output).toBe("");
      expect(result.note).toContain("[OUTPUT OVERFLOW");
      expect(result.note).toContain("saved to");
      expect(result.exitCode).toBe(0);

      // Extract and verify temp file
      const match = /saved to (\/.*?\.txt)/.exec(result.note ?? "");
      expect(match).toBeDefined();
      if (match) {
        const overflowPath = match[1];
        expect(fs.existsSync(overflowPath)).toBe(true);

        // Verify file contains ALL lines collected (should be ~1300 lines, ~50KB)
        const fileContent = fs.readFileSync(overflowPath, "utf-8");
        const fileLines = fileContent.split("\n").filter((l: string) => l.length > 0);

        // Should have collected all 1300 lines (not stopped at display limit)
        expect(fileLines.length).toBeGreaterThanOrEqual(1250);
        expect(fileLines.length).toBeLessThanOrEqual(1350);

        // Verify file size is between 45KB and 55KB
        const fileStats = fs.statSync(overflowPath);
        expect(fileStats.size).toBeGreaterThan(45 * 1024);
        expect(fileStats.size).toBeLessThan(55 * 1024);

        // Clean up
        fs.unlinkSync(overflowPath);
      }
    }

    tempDir[Symbol.dispose]();
  });

  it("should stop collection at 100KB file limit", async () => {
    const tempDir = new TestTempDir("test-bash-100kb-limit");
    const tool = createBashTool({
      ...getTestDeps(),
      cwd: process.cwd(),
      runtime: new LocalRuntime(process.cwd()),
      runtimeTempDir: tempDir.path,
    });

    // Generate ~150KB of output (exceeds 100KB file limit)
    // Each line is ~100 bytes
    // 150KB / 100 bytes = ~1500 lines
    const args: BashToolArgs = {
      run_in_background: false,
      script: "for i in {1..1600}; do printf 'line%04d: '; printf 'x%.0s' {1..80}; echo; done",
      timeout_secs: 10,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      // Should hit file limit
      expect(result.output).toBe("");
      expect(result.note).toContain("file preservation limit");
      expect(result.exitCode).toBe(0);

      // Extract and verify temp file
      const match = /saved to (\/.*?\.txt)/.exec(result.note ?? "");
      expect(match).toBeDefined();
      if (match) {
        const overflowPath = match[1];
        expect(fs.existsSync(overflowPath)).toBe(true);

        // Verify file is capped around 100KB (not 150KB)
        const fileStats = fs.statSync(overflowPath);
        expect(fileStats.size).toBeLessThanOrEqual(105 * 1024); // Allow 5KB buffer
        expect(fileStats.size).toBeGreaterThan(95 * 1024);

        // Clean up
        fs.unlinkSync(overflowPath);
      }
    }

    tempDir[Symbol.dispose]();
  });

  it("should NOT kill process at display limit (16KB) - verify command completes naturally", async () => {
    const tempDir = new TestTempDir("test-bash-no-kill-display");
    const tool = createBashTool({
      ...getTestDeps(),
      cwd: process.cwd(),
      runtime: new LocalRuntime(process.cwd()),
      runtimeTempDir: tempDir.path,
    });

    // Generate output that exceeds display limit but not file limit
    // Also includes a delay at the END to verify process wasn't killed early
    const args: BashToolArgs = {
      script:
        "for i in {1..500}; do printf 'line%04d with padding text\\n' $i; done; echo 'COMPLETION_MARKER'",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      // Should hit display limit
      expect(result.note).toContain("display limit");
      expect(result.exitCode).toBe(0);

      // Extract and verify temp file contains the completion marker
      const match = /saved to (\/.*?\.txt)/.exec(result.note ?? "");
      expect(match).toBeDefined();
      if (match) {
        const overflowPath = match[1];
        const fileContent = fs.readFileSync(overflowPath, "utf-8");

        // CRITICAL: File must contain COMPLETION_MARKER, proving command ran to completion
        // If process was killed at display limit, this marker would be missing
        expect(fileContent).toContain("COMPLETION_MARKER");

        // Clean up
        fs.unlinkSync(overflowPath);
      }
    }

    tempDir[Symbol.dispose]();
  });

  it("should kill process immediately when single line exceeds per-line limit", async () => {
    const tempDir = new TestTempDir("test-bash-per-line-kill");
    const tool = createBashTool({
      ...getTestDeps(),
      cwd: process.cwd(),
      runtime: new LocalRuntime(process.cwd()),
      runtimeTempDir: tempDir.path,
    });

    // Generate a single line exceeding 1KB limit, then try to output more
    const args: BashToolArgs = {
      run_in_background: false,
      script: "printf 'x%.0s' {1..2000}; echo; echo 'SHOULD_NOT_APPEAR'",
      timeout_secs: 5,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      // Should hit per-line limit (file truncation, not display)
      expect(result.output).toBe("");
      expect(result.note).toContain("per-line limit");
      expect(result.exitCode).toBe(0);

      // Extract and verify temp file does NOT contain the second echo
      const match = /saved to (\/.*?\.txt)/.exec(result.note ?? "");
      expect(match).toBeDefined();
      if (match) {
        const overflowPath = match[1];
        const fileContent = fs.readFileSync(overflowPath, "utf-8");

        // CRITICAL: File must NOT contain SHOULD_NOT_APPEAR
        // This proves process was killed immediately at per-line limit
        expect(fileContent).not.toContain("SHOULD_NOT_APPEAR");

        // Clean up
        fs.unlinkSync(overflowPath);
      }
    }

    tempDir[Symbol.dispose]();
  });

  it("should handle output just under 16KB without truncation", async () => {
    const tempDir = new TestTempDir("test-bash-under-limit");
    const tool = createBashTool({
      ...getTestDeps(),
      cwd: process.cwd(),
      runtime: new LocalRuntime(process.cwd()),
      runtimeTempDir: tempDir.path,
    });

    // Generate ~15KB of output (just under 16KB display limit)
    // Each line is ~50 bytes, 15KB / 50 = 300 lines exactly (at the line limit)
    const args: BashToolArgs = {
      run_in_background: false,
      script: "for i in {1..299}; do printf 'line%04d with some padding text here now\\n' $i; done",
      timeout_secs: 5,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    // Should succeed without overflow (299 lines < 300 line limit)
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain("line0001");
      expect(result.output).toContain("line0299");
      // Should NOT have created a temp file
      const files = fs.readdirSync(tempDir.path);
      expect(files.length).toBe(0);
    }

    tempDir[Symbol.dispose]();
  });

  it("should trigger display truncation at exactly 300 lines", async () => {
    const tempDir = new TestTempDir("test-bash-exact-limit");
    const tool = createBashTool({
      ...getTestDeps(),
      cwd: process.cwd(),
      runtime: new LocalRuntime(process.cwd()),
      runtimeTempDir: tempDir.path,
    });

    // Generate exactly 300 lines (hits line limit exactly)
    const args: BashToolArgs = {
      run_in_background: false,
      script: "for i in {1..300}; do printf 'line%04d\\n' $i; done",
      timeout_secs: 5,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    // Should trigger display truncation at exactly 300 lines
    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      expect(result.output).toBe("");
      expect(result.note).toContain("[OUTPUT OVERFLOW");
      expect(result.note).toContain("300 lines");
      expect(result.note).toContain("display limit");
      expect(result.exitCode).toBe(0);
    }

    tempDir[Symbol.dispose]();
  });

  it("should interleave stdout and stderr", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      script: "echo stdout1 && echo stderr1 >&2 && echo stdout2 && echo stderr2 >&2",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      // Output should contain all lines interleaved
      expect(result.output).toContain("stdout1");
      expect(result.output).toContain("stderr1");
      expect(result.output).toContain("stdout2");
      expect(result.output).toContain("stderr2");
    }
  });

  it("should handle command failure with exit code", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      script: "exit 42",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.exitCode).toBe(42);
      expect(result.error).toContain("exited with code 42");
    }
  });

  it("should timeout long-running commands", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      script: "while true; do sleep 0.1; done",
      timeout_secs: 1,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("timeout");
      expect(result.exitCode).toBe(-1);
    }
  });

  it("should handle empty output", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      script: "true",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe("");
      expect(result.exitCode).toBe(0);
    }
  });

  it("should complete instantly for grep-like commands (regression test)", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const startTime = performance.now();

    // This test catches the bug where readline interface close events
    // weren't firing, causing commands with minimal output to hang
    const args: BashToolArgs = {
      script: "echo 'test:first-child' | grep ':first-child'",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;
    const duration = performance.now() - startTime;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain("first-child");
      expect(result.exitCode).toBe(0);
      // Should complete in well under 1 second (give 2s buffer for slow machines)
      expect(duration).toBeLessThan(2000);
    }
  });

  it("should not hang on commands that read from stdin (cat test)", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const startTime = performance.now();

    // cat without input should complete immediately
    // This used to hang because stdin.close() would wait for acknowledgment
    // Fixed by using stdin.abort() for immediate closure
    const args: BashToolArgs = {
      script: "echo test | cat",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;
    const duration = performance.now() - startTime;

    // Should complete almost instantly (not wait for timeout)
    expect(duration).toBeLessThan(4000);

    // cat with no input should succeed with empty output (stdin is closed)
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain("test");
      expect(duration).toBeLessThan(2000);
    }
  });

  it("should present stdin as a non-pipe for search tools", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;

    const args: BashToolArgs = {
      script:
        'python3 -c "import os,stat;mode=os.fstat(0).st_mode;print(stat.S_IFMT(mode)==stat.S_IFIFO)"',
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.trim()).toBe("False");
    }
  });

  it("should not hang on git rebase --continue", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const startTime = performance.now();

    // Extremely minimal case - just enough to trigger rebase --continue
    const script = `
      T=$(mktemp -d) && cd "$T"
      git init && git config user.email "t@t" && git config user.name "T" && git config commit.gpgsign false
      echo a > f && git add f && git commit -m a
      git checkout -b b && echo b > f && git commit -am b
      git checkout main && echo c > f && git commit -am c
      git rebase b || true
      echo resolved > f && git add f
      git rebase --continue
    `;

    const result = (await tool.execute!(
      { script, timeout_secs: 5 },
      mockToolCallOptions
    )) as BashToolResult;

    const duration = performance.now() - startTime;

    expect(duration).toBeLessThan(4000);
    expect(result).toBeDefined();
  });

  it("should work with just script and timeout", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;

    const args: BashToolArgs = {
      script: "echo test",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe("test");
    }
  });

  it("should allow commands that don't start with cd", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;

    const args: BashToolArgs = {
      script: "echo 'cd' && echo test",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain("cd");
      expect(result.output).toContain("test");
    }
  });

  it("should complete quickly when background process is spawned", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const startTime = performance.now();

    const args: BashToolArgs = {
      // Background process that would block if we waited for it
      script: "while true; do sleep 1; done > /dev/null 2>&1 &",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;
    const duration = performance.now() - startTime;

    expect(result.success).toBe(true);
    // Should complete in well under 1 second, not wait for infinite loop
    expect(duration).toBeLessThan(2000);
  });

  it("should complete quickly with background process and PID echo", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const startTime = performance.now();

    const args: BashToolArgs = {
      // Spawn background process, echo its PID, then exit
      // Should not wait for the background process
      script: "while true; do sleep 1; done > /dev/null 2>&1 & echo $!",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;
    const duration = performance.now() - startTime;

    expect(result.success).toBe(true);
    if (result.success) {
      // Should output the PID
      expect(result.output).toMatch(/^\d+$/);
    }
    // Should complete quickly
    expect(duration).toBeLessThan(2000);
  });

  it("should timeout background processes that don't complete", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const startTime = performance.now();

    const args: BashToolArgs = {
      // Background process with output redirected but still blocking
      script: "while true; do sleep 0.1; done & wait",
      timeout_secs: 1,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;
    const duration = performance.now() - startTime;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("timeout");
      expect(duration).toBeLessThan(2000);
    }
  });

  it("should report overflow when line exceeds max line bytes", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const longLine = "x".repeat(2000);
    const args: BashToolArgs = {
      script: `echo '${longLine}'`,
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      expect(result.output).toBe("");
      expect(result.note).toMatch(/exceeded per-line limit|OUTPUT OVERFLOW/);
      expect(result.exitCode).toBe(0);
    }
  });

  it("should report overflow when total bytes limit exceeded", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const lineContent = "x".repeat(100);
    const numLines = Math.ceil(BASH_MAX_TOTAL_BYTES / 100) + 50;
    const args: BashToolArgs = {
      script: `for i in {1..${numLines}}; do echo '${lineContent}'; done`,
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      expect(result.output).toBe("");
      expect(result.note).toMatch(/Total output exceeded limit|OUTPUT OVERFLOW/);
      expect(result.exitCode).toBe(0);
    }
  });

  it("should report overflow when byte limit is reached", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      run_in_background: false,
      script: `for i in {1..1000}; do echo 'This is line number '$i' with some content'; done`,
      timeout_secs: 5,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (isForegroundSuccess(result)) {
      expect(result.output).toBe("");
      expect(result.note).toMatch(/Total output exceeded limit|OUTPUT OVERFLOW/);
      expect(result.exitCode).toBe(0);
    }
  });

  it("should fail immediately when script is empty", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      script: "",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Script parameter is empty");
      expect(result.error).toContain("malformed tool call");
      expect(result.exitCode).toBe(-1);
      expect(result.wall_duration_ms).toBe(0);
    }
  });

  describe("script sanitization", () => {
    const shouldRewriteNullRedirects = process.platform === "win32";

    it("should rewrite >nul to /dev/null (and not create a `nul` file)", async () => {
      using tempDir = new TestTempDir("test-bash-nul-redirect");
      const tool = createBashTool(createTestToolConfig(tempDir.path));

      const args: BashToolArgs = {
        script: "echo hello >nul",
        timeout_secs: 5,
        run_in_background: false,
        display_name: "test",
      };

      const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

      expect(result.success).toBe(true);
      if (isForegroundSuccess(result)) {
        if (shouldRewriteNullRedirects) {
          expect(result.note).toContain("Rewrote `>nul`/`2>nul`");
        } else {
          expect(result.note).toBeUndefined();
        }
      }

      expect(fs.existsSync(path.join(tempDir.path, "nul"))).toBe(!shouldRewriteNullRedirects);
    });

    it("should rewrite 2>nul to /dev/null (and not create a `nul` file)", async () => {
      using tempDir = new TestTempDir("test-bash-nul-redirect-stderr");
      const tool = createBashTool(createTestToolConfig(tempDir.path));

      const args: BashToolArgs = {
        script: "ls does-not-exist 2>nul || true",
        timeout_secs: 5,
        run_in_background: false,
        display_name: "test",
      };

      const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

      expect(result.success).toBe(true);
      if (isForegroundSuccess(result)) {
        if (shouldRewriteNullRedirects) {
          expect(result.note).toContain("Rewrote `>nul`/`2>nul`");
        } else {
          expect(result.note).toBeUndefined();
        }
      }

      expect(fs.existsSync(path.join(tempDir.path, "nul"))).toBe(!shouldRewriteNullRedirects);
    });

    it("should not rewrite an explicit path like >./nul", async () => {
      using tempDir = new TestTempDir("test-bash-dot-nul");
      const tool = createBashTool(createTestToolConfig(tempDir.path));

      const args: BashToolArgs = {
        script: "echo hello >./nul",
        timeout_secs: 5,
        run_in_background: false,
        display_name: "test",
      };

      const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

      expect(result.success).toBe(true);
      if (isForegroundSuccess(result)) {
        expect(result.note).toBeUndefined();
      }

      expect(fs.existsSync(path.join(tempDir.path, "nul"))).toBe(true);
    });
  });

  it("should fail immediately when script is only whitespace", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      script: "   \n\t  ",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Script parameter is empty");
      expect(result.exitCode).toBe(-1);
      expect(result.wall_duration_ms).toBe(0);
    }
  });

  it("should allow sleep command at start of script", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      script: "sleep 0.1; echo done",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe("done");
      expect(result.exitCode).toBe(0);
    }
  });

  it("should allow sleep in polling loops", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      script: "for i in 1 2 3; do echo $i; sleep 0.1; done",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain("1");
      expect(result.output).toContain("2");
      expect(result.output).toContain("3");
    }
  });

  it("should use default timeout (3s) when timeout_secs is undefined", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args = {
      script: "echo hello",
      timeout_secs: undefined,
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe("hello");
      expect(result.exitCode).toBe(0);
    }
  });

  it("should use default timeout (3s) when timeout_secs is omitted", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args = {
      script: "echo hello",
      // timeout_secs omitted entirely
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toBe("hello");
      expect(result.exitCode).toBe(0);
    }
  });

  // Note: Zero and negative timeout_secs are rejected by Zod schema validation
  // before reaching the execute function, so these cases are handled at the schema level
});

describe("zombie process cleanup", () => {
  it("should not create zombie processes when spawning background tasks", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;

    // Spawn a background sleep process that would become a zombie if not cleaned up
    // Use a unique marker to identify our test process
    const marker = `zombie-test-${Date.now()}`;
    const args: BashToolArgs = {
      script: `echo "${marker}"; sleep 100 & echo $!`,
      timeout_secs: 1,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    // Tool should complete successfully
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain(marker);
      const lines = result.output.split("\n");
      const bgPid = lines[1]; // Second line should be the background PID

      // Give a moment for cleanup to happen
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify the background process was killed (process group cleanup)
      using checkEnv = createTestBashTool();
      const checkResult = (await checkEnv.tool.execute!(
        {
          script: `ps -p ${bgPid} > /dev/null 2>&1 && echo "ALIVE" || echo "DEAD"`,
          timeout_secs: 1,
        },
        mockToolCallOptions
      )) as BashToolResult;

      expect(checkResult.success).toBe(true);
      if (checkResult.success) {
        expect(checkResult.output).toBe("DEAD");
      }
    }
  });

  it("should kill all processes when aborted via AbortController", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;

    // Create AbortController to simulate user interruption
    const abortController = new AbortController();

    // Use unique token to identify our test processes
    const token = (100 + Math.random() * 100).toFixed(4); // Unique duration for grep

    // Spawn a command that creates child processes (simulating cargo build)
    const args: BashToolArgs = {
      script: `
        # Simulate cargo spawning rustc processes
        for i in {1..5}; do
          (echo "child-\${i}"; exec sleep ${token}) &
          echo "SPAWNED:$!"
        done
        echo "ALL_SPAWNED"
        # Wait so we can abort while children are running
        exec sleep ${token}
      `,
      timeout_secs: 10,
      run_in_background: false,
      display_name: "test",
    };

    // Start the command
    const resultPromise = tool.execute!(args, {
      ...mockToolCallOptions,
      abortSignal: abortController.signal,
    }) as Promise<BashToolResult>;

    // Wait for children to spawn
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Abort the operation (simulating Ctrl+C)
    abortController.abort();

    // Wait for the result
    const result = await resultPromise;

    // Command should be aborted
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("aborted");
    }

    // Wait for all processes to be cleaned up (SIGKILL needs time to propagate in CI)
    // Retry with exponential backoff instead of fixed wait
    // Use ps + grep to avoid pgrep matching itself
    let remainingProcesses = -1;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));

      using checkEnv = createTestBashTool();
      const checkResult = (await checkEnv.tool.execute!(
        {
          script: `ps aux | grep "sleep ${token}" | grep -v grep | wc -l`,
          timeout_secs: 1,
        },
        mockToolCallOptions
      )) as BashToolResult;

      expect(checkResult.success).toBe(true);
      if (checkResult.success) {
        remainingProcesses = parseInt(checkResult.output.trim());
        if (remainingProcesses === 0) {
          break;
        }
      }
    }

    expect(remainingProcesses).toBe(0);
  });

  it("should abort quickly when command produces continuous output", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;

    // Create AbortController to simulate user interruption
    const abortController = new AbortController();

    // Command that produces slow, continuous output
    // The key is it keeps running, so the abort happens while reader.read() is waiting
    const args: BashToolArgs = {
      script: `
        # Produce continuous output slowly (prevents hitting truncation limits)
        for i in {1..1000}; do
          echo "Output line $i"
          sleep 0.1
        done
      `,
      timeout_secs: 120,
      run_in_background: false,
      display_name: "test",
    };

    // Start the command
    const resultPromise = tool.execute!(args, {
      ...mockToolCallOptions,
      abortSignal: abortController.signal,
    }) as Promise<BashToolResult>;

    // Wait for output to start (give it time to produce a few lines)
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Abort the operation while it's still producing output
    const abortTime = Date.now();
    abortController.abort();

    // Wait for the result with a timeout to detect hangs
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Test timeout - tool did not abort quickly")), 5000)
    );

    const result = (await Promise.race([resultPromise, timeoutPromise])) as BashToolResult;
    const duration = Date.now() - abortTime;

    // Command should be aborted
    expect(result.success).toBe(false);
    if (!result.success) {
      // Error should mention abort or indicate the process was killed
      const errorText = result.error.toLowerCase();
      expect(
        errorText.includes("abort") ||
          errorText.includes("killed") ||
          errorText.includes("signal") ||
          result.exitCode === -1
      ).toBe(true);
    }

    // CRITICAL: Tool should return quickly after abort (< 2s)
    // This is the regression test - without checking abort signal in consumeStream(),
    // the tool hangs until the streams close (which can take a long time)
    expect(duration).toBeLessThan(2000);
  });
});

describe("remote bash git hardening", () => {
  it("discovers remote drivers and keeps provider secrets blanked", async () => {
    const calls: Array<{ command: string; options: ExecOptions }> = [];
    const runtime = {
      exec(command: string, options: ExecOptions): Promise<ExecStream> {
        calls.push({ command, options });
        if (command.includes("rev-parse --git-dir"))
          return Promise.resolve(createExecStream(".git\n"));
        if (command.includes("includeif[.]")) return Promise.resolve(createExecStream(""));
        if (options.cwd === "/remote/workspace/project-a") {
          return Promise.resolve(createExecStream("", 1));
        }
        if (options.cwd === "/remote/workspace/project-b") {
          return Promise.resolve(
            createExecStream(
              "filter.evil.smudge\ncat\0filter.evil.required\ntrue\0alias.evil\n!steal\0"
            )
          );
        }
        return Promise.resolve(createExecStream("done\n"));
      },
    } as unknown as Runtime;
    const config = createTestToolConfig("/remote/workspace");
    config.runtime = runtime;
    config.trusted = false;
    config.projects = [
      { projectName: "project-a", projectPath: "/remote/project-a" },
      { projectName: "project-b", projectPath: "/remote/project-b" },
    ];
    config.secrets = { ANTHROPIC_API_KEY: "secret" };
    const tool = createBashTool(config);

    const result = (await tool.execute!(
      {
        script: "git checkout -- data.txt",
        timeout_secs: 5,
        run_in_background: false,
        display_name: "test",
      },
      mockToolCallOptions
    )) as BashToolResult;

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(7);
    expect(calls[0]?.options.cwd).toBe("/remote/workspace/project-a");
    expect(calls[3]?.options.cwd).toBe("/remote/workspace/project-b");
    expect(calls[6]?.options.env?.ANTHROPIC_API_KEY).toBe("");
    expect(Object.values(calls[6]?.options.env ?? {})).toContain("filter.evil.smudge");
    expect(Object.values(calls[6]?.options.env ?? {})).toContain("alias.evil");
  });

  it("fails closed when remote driver discovery fails", async () => {
    let callCount = 0;
    const runtime = {
      exec(): Promise<ExecStream> {
        const exitCodes = [0, 0, 1, 0, 2];
        const exitCode = exitCodes[callCount] ?? 2;
        callCount += 1;
        return Promise.resolve(createExecStream("", exitCode));
      },
    } as unknown as Runtime;
    const config = createTestToolConfig("/remote/workspace");
    config.runtime = runtime;
    config.trusted = false;
    config.projects = [
      { projectName: "project-a", projectPath: "/remote/project-a" },
      { projectName: "project-b", projectPath: "/remote/project-b" },
    ];
    const tool = createBashTool(config);

    let rejection: unknown;
    try {
      await tool.execute!(
        {
          script: "echo should-not-run",
          timeout_secs: 5,
          run_in_background: false,
          display_name: "test",
        },
        mockToolCallOptions
      );
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("Failed to inspect repository");
    expect(callCount).toBe(5);
  });

  it("blanks run-session roots inherited by local Bash", async () => {
    const previousXumRoot = process.env.XUM_RUN_SESSION_ROOT;
    const previousMuxRoot = process.env.MUX_RUN_SESSION_ROOT;
    process.env.XUM_RUN_SESSION_ROOT = "/tmp/xum-session";
    process.env.MUX_RUN_SESSION_ROOT = "/tmp/mux-session";

    try {
      const config = createTestToolConfig(process.cwd());
      config.trusted = false;
      const tool = createBashTool(config);
      const result = (await tool.execute!(
        {
          script: 'printf "%s|%s" "$XUM_RUN_SESSION_ROOT" "$MUX_RUN_SESSION_ROOT"',
          timeout_secs: 5,
          run_in_background: false,
          display_name: "test",
        },
        mockToolCallOptions
      )) as BashToolResult;

      expect(result.success).toBe(true);
      if (result.success) expect(result.output).toBe("|");
    } finally {
      if (previousXumRoot == null) delete process.env.XUM_RUN_SESSION_ROOT;
      else process.env.XUM_RUN_SESSION_ROOT = previousXumRoot;
      if (previousMuxRoot == null) delete process.env.MUX_RUN_SESSION_ROOT;
      else process.env.MUX_RUN_SESSION_ROOT = previousMuxRoot;
    }
  });
});

describe("xumEnv environment variables", () => {
  it("should inject MUX_ environment variables when xumEnv is provided", async () => {
    using tempDir = new TestTempDir("test-mux-env");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.xumEnv = {
      MUX_PROJECT_PATH: "/test/project/path",
      MUX_RUNTIME: "worktree",
      MUX_WORKSPACE_NAME: "feature-branch",
    };
    const tool = createBashTool(config);

    const args: BashToolArgs = {
      script: 'echo "PROJECT:$MUX_PROJECT_PATH RUNTIME:$MUX_RUNTIME WORKSPACE:$MUX_WORKSPACE_NAME"',
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output).toContain("PROJECT:/test/project/path");
      expect(result.output).toContain("RUNTIME:worktree");
      expect(result.output).toContain("WORKSPACE:feature-branch");
    }
  });

  it("should allow secrets to override xumEnv", async () => {
    using tempDir = new TestTempDir("test-mux-env-override");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.xumEnv = {
      MUX_PROJECT_PATH: "/mux/path",
      CUSTOM_VAR: "from-mux",
    };
    config.secrets = {
      CUSTOM_VAR: "from-secrets",
    };
    const tool = createBashTool(config);

    const args: BashToolArgs = {
      script: 'echo "MUX:$MUX_PROJECT_PATH CUSTOM:$CUSTOM_VAR"',
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      // MUX_PROJECT_PATH from xumEnv should be present
      expect(result.output).toContain("MUX:/mux/path");
      // Secrets should override xumEnv when there's a conflict
      expect(result.output).toContain("CUSTOM:from-secrets");
    }
  });
});

describe("SSH runtime redundant cd detection", () => {
  // Helper to create bash tool with SSH runtime configuration
  // Note: These tests check redundant cd detection logic only - they don't actually execute via SSH
  function createTestBashToolWithSSH(cwd: string) {
    const tempDir = new TestTempDir("test-bash-ssh");
    const sshConfig = {
      type: "ssh" as const,
      host: "test-host",
      srcBaseDir: "/remote/base",
    };
    const sshRuntime = createRuntime(sshConfig);

    // Pre-mark connection as healthy to skip actual SSH probe in tests
    sshConnectionPool.markHealthy(sshConfig);

    const tool = createBashTool({
      ...getTestDeps(),
      cwd,
      runtime: sshRuntime,
      runtimeTempDir: tempDir.path,
    });

    return {
      tool,
      [Symbol.dispose]() {
        tempDir[Symbol.dispose]();
      },
    };
  }

  it("should reject redundant cd when command cds to working directory", async () => {
    const remoteCwd = "/remote/workspace/project/branch";
    using testEnv = createTestBashToolWithSSH(remoteCwd);
    const tool = testEnv.tool;

    const args: BashToolArgs = {
      script: "cd /remote/workspace/project/branch && echo test",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    // Should reject the redundant cd
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Redundant cd to working directory");
      expect(result.error).toContain("no cd needed");
      expect(result.exitCode).toBe(-1);
    }
  });

  it("should not treat cd to a different directory as redundant", () => {
    // Only testing normalization here - SSH execution would hang (no real host).
    const remoteCwd = "/remote/workspace/project/branch";

    const sshRuntime = createRuntime({
      type: "ssh" as const,
      host: "test-host",
      srcBaseDir: "/remote/base",
    });

    const normalizedTarget = sshRuntime.normalizePath("/tmp", remoteCwd);
    const normalizedCwd = sshRuntime.normalizePath(".", remoteCwd);

    expect(normalizedTarget).not.toBe(normalizedCwd);
  });
});

describe("bash tool - tool_env", () => {
  it("should source .mux/tool_env before running script", async () => {
    using tempDir = new TestTempDir("test-bash-tool-env");
    const muxDir = `${tempDir.path}/.mux`;
    fs.mkdirSync(muxDir, { recursive: true });
    fs.writeFileSync(`${muxDir}/tool_env`, "export MUX_TEST_VAR=from_tool_env");

    const config = createTestToolConfig(tempDir.path);
    config.runtimeTempDir = tempDir.path;
    config.trusted = true;
    const tool = createBashTool(config);

    const args: BashToolArgs = {
      script: "echo $MUX_TEST_VAR",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    expect(result.output).toBe("from_tool_env");
  });

  it("should fail with clear error if tool_env sourcing fails", async () => {
    using tempDir = new TestTempDir("test-bash-tool-env-fail");
    const muxDir = `${tempDir.path}/.mux`;
    fs.mkdirSync(muxDir, { recursive: true });
    // Fail `source` without terminating the parent shell.
    fs.writeFileSync(`${muxDir}/tool_env`, "return 1");

    const config = createTestToolConfig(tempDir.path);
    config.runtimeTempDir = tempDir.path;
    config.trusted = true;
    const tool = createBashTool(config);

    const args: BashToolArgs = {
      script: "echo should_not_run",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("failed to source");
  });

  it("should run script normally when no tool_env exists", async () => {
    using tempDir = new TestTempDir("test-bash-no-tool-env");

    const config = createTestToolConfig(tempDir.path);
    config.runtimeTempDir = tempDir.path;
    const tool = createBashTool(config);

    const args: BashToolArgs = {
      script: "echo normal_execution",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    expect(result.output).toBe("normal_execution");
  });
});

describe("bash tool - tool_env trust gating", () => {
  it("should NOT source tool_env when project is untrusted", async () => {
    using tempDir = new TestTempDir("test-bash-untrusted-env");
    const muxDir = `${tempDir.path}/.mux`;
    fs.mkdirSync(muxDir, { recursive: true });
    fs.writeFileSync(`${muxDir}/tool_env`, "export MUX_TEST_VAR=from_tool_env");

    const config = createTestToolConfig(tempDir.path);
    config.runtimeTempDir = tempDir.path;
    // trusted is undefined (default) — tool_env should be skipped
    const tool = createBashTool(config);

    const args: BashToolArgs = {
      script: "echo ${MUX_TEST_VAR:-not_sourced}",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    expect(result.output).toBe("not_sourced");
  });

  it("should source tool_env when project is trusted", async () => {
    using tempDir = new TestTempDir("test-bash-trusted-env");
    const muxDir = `${tempDir.path}/.mux`;
    fs.mkdirSync(muxDir, { recursive: true });
    fs.writeFileSync(`${muxDir}/tool_env`, "export MUX_TEST_VAR=from_tool_env");

    const config = createTestToolConfig(tempDir.path);
    config.runtimeTempDir = tempDir.path;
    config.trusted = true;
    const tool = createBashTool(config);

    const args: BashToolArgs = {
      script: "echo $MUX_TEST_VAR",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    expect(result.output).toBe("from_tool_env");
  });
});

describe("bash tool - background execution", () => {
  it("should reject background mode when manager not available", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args: BashToolArgs = {
      script: "echo test",
      timeout_secs: 5,
      run_in_background: true,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Background execution is only available for AI tool calls");
    }
  });

  it("should accept timeout with background mode for auto-termination", async () => {
    const manager = new BackgroundProcessManager("/tmp/mux-test-bg");

    const tempDir = new TestTempDir("test-bash-bg");
    const config = createTestToolConfig(tempDir.path);
    config.backgroundProcessManager = manager;

    const tool = createBashTool(config);
    const args: BashToolArgs = {
      script: "echo test",
      timeout_secs: 5,
      run_in_background: true,
      display_name: "test-timeout-bg",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    // Background with timeout should succeed - timeout is used for auto-termination
    expect(result.success).toBe(true);
    if (result.success && "backgroundProcessId" in result) {
      expect(result.backgroundProcessId).toBe("test-timeout-bg");
    }

    await manager.terminateAll();
    tempDir[Symbol.dispose]();
  });

  it("should start background process and return process ID", async () => {
    const manager = new BackgroundProcessManager("/tmp/mux-test-bg");

    const tempDir = new TestTempDir("test-bash-bg");
    const config = createTestToolConfig(tempDir.path);
    config.backgroundProcessManager = manager;

    const tool = createBashTool(config);
    const args: BashToolArgs = {
      script: "echo hello",
      timeout_secs: 5,
      run_in_background: true,
      display_name: "test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success && "backgroundProcessId" in result) {
      expect(result.backgroundProcessId).toBeDefined();

      // Process ID is now the display name directly
      expect(result.backgroundProcessId).toBe("test");
    } else {
      throw new Error("Expected background process ID in result");
    }

    tempDir[Symbol.dispose]();
  });

  it("terminates the process and fails when foreground-to-background migration fails", async () => {
    const tempDir = new TestTempDir("test-bash-migrate-fail");
    // Point the manager's output root at a regular FILE so migrateToBackground's mkdir
    // fails deterministically (stand-in for ENOSPC/EACCES-style failures).
    const blockedRoot = path.join(tempDir.path, "bg-root-blocked");
    fs.writeFileSync(blockedRoot, "not a directory");
    const manager = new BackgroundProcessManager(blockedRoot);

    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const tool = createBashTool(config);
    const pidFile = path.join(tempDir.path, "migrate-fail.pid");
    const resultPromise = tool.execute!(
      {
        script: `echo $$ > "${pidFile}"; sleep 30`,
        timeout_secs: 60,
        run_in_background: false,
        display_name: "migrate-fail",
      },
      mockToolCallOptions
    ) as Promise<BashToolResult>;

    // Wait for the script to be running before clicking "send to background".
    const startDeadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile) && Date.now() < startDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fs.existsSync(pidFile)).toBe(true);

    const sendResult = manager.sendToBackground(mockToolCallOptions.toolCallId);
    expect(sendResult.success).toBe(true);

    // An untracked live process would be invisible to archive gates and crash-orphan scans,
    // so a failed migration must terminate the process and report failure instead of
    // claiming the process will continue running.
    const result = await resultPromise;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("terminated because it could not be tracked");
    }

    const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    expect(pid).toBeGreaterThan(1);
    const killDeadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < killDeadline) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);

    tempDir[Symbol.dispose]();
  }, 15000);

  it("should arm monitor for background mode and echo monitor config", async () => {
    const manager = new BackgroundProcessManager("/tmp/mux-test-bg");

    const tempDir = new TestTempDir("test-bash-bg-monitor");
    const config = createTestToolConfig(tempDir.path);
    config.backgroundProcessManager = manager;

    const tool = createBashTool(config);
    const args: BashToolArgs = {
      script: "echo ERROR",
      timeout_secs: 5,
      run_in_background: true,
      display_name: "test-monitor-bg",
      monitor: {
        filter: "ERROR",
        filter_exclude: false,
        cooldown_ms: 0,
      },
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success && "backgroundProcessId" in result) {
      expect(result.output).toContain("Monitor armed");
      expect(result.monitor).toMatchObject({
        filter: "ERROR",
        filter_exclude: false,
        cooldown_ms: 0,
      });
    } else {
      throw new Error("Expected background process ID in result");
    }

    await manager.terminateAll();
    tempDir[Symbol.dispose]();
  });

  it("should reject a monitor without background mode", async () => {
    using testEnv = createTestBashTool();
    const tool = testEnv.tool;
    const args = {
      script: "echo ERROR",
      timeout_secs: 5,
      run_in_background: false,
      display_name: "test-monitor-foreground",
      monitor: {
        filter: "ERROR",
        filter_exclude: false,
        cooldown_ms: 0,
      },
    } satisfies BashToolArgs;

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("monitor requires run_in_background=true");
    }
  });

  it("should reject invalid monitor regex without spawning", async () => {
    const manager = new BackgroundProcessManager("/tmp/mux-test-bg");

    const tempDir = new TestTempDir("test-bash-bg-monitor-regex");
    const config = createTestToolConfig(tempDir.path);
    config.backgroundProcessManager = manager;

    const tool = createBashTool(config);
    const args: BashToolArgs = {
      script: "echo ERROR",
      timeout_secs: 5,
      run_in_background: true,
      display_name: "test-monitor-bad-regex",
      monitor: {
        filter: "[",
        filter_exclude: false,
        cooldown_ms: 0,
      },
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid monitor filter regex");
    }
    expect(await manager.list(config.workspaceId)).toHaveLength(0);

    await manager.terminateAll();
    tempDir[Symbol.dispose]();
  });

  it("should inject xumEnv environment variables in background mode", async () => {
    const manager = new BackgroundProcessManager("/tmp/mux-test-bg");

    const tempDir = new TestTempDir("test-bash-bg-mux-env");
    const config = createTestToolConfig(tempDir.path);
    config.backgroundProcessManager = manager;
    config.xumEnv = {
      MUX_MODEL_STRING: "openai:gpt-5.2",
      MUX_THINKING_LEVEL: "medium",
    };

    const tool = createBashTool(config);
    const args: BashToolArgs = {
      script: 'echo "MODEL:$MUX_MODEL_STRING THINKING:$MUX_THINKING_LEVEL"',
      timeout_secs: 5,
      run_in_background: true,
      display_name: "test-mux-env-bg",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashToolResult;

    expect(result.success).toBe(true);
    if (result.success && "backgroundProcessId" in result) {
      const outputResult = await manager.getOutput(
        result.backgroundProcessId,
        undefined,
        undefined,
        2
      );
      expect(outputResult.success).toBe(true);
      if (outputResult.success) {
        expect(outputResult.output).toContain("MODEL:openai:gpt-5.2");
        expect(outputResult.output).toContain("THINKING:medium");
      }
    } else {
      throw new Error("Expected background process ID in result");
    }

    await manager.terminateAll();
    tempDir[Symbol.dispose]();
  });
});
