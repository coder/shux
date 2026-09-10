import { existsSync } from "fs";
import { describe, it, expect, spyOn } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import type { ToolExecutionOptions } from "ai";

import type { LocalRuntime } from "@/node/runtime/LocalRuntime";
const GLOBAL_WORKSPACE_ID = "workspace-global";
const GLOBAL_WORKSPACE_NAME = "global-scope";
const GLOBAL_WORKSPACE_TITLE = "Global Scope";
import type { XumToolScope } from "@/common/types/toolScope";
import { FILE_EDIT_DIFF_OMITTED_MESSAGE } from "@/common/types/tools";

import { resolveAgentsPathOnRuntime } from "./xum_agents_path";
import { createXumAgentsReadTool } from "./xum_agents_read";
import { createXumAgentsWriteTool } from "./xum_agents_write";
import { TestTempDir, createTestToolConfig, RemotePathMappedRuntime } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions<unknown> = {
  toolCallId: "test-call-id",
  messages: [],
  context: undefined,
};

function createGlobalXumAgentsToolConfig(xumHome: string, workspaceSessionDir: string) {
  return {
    ...createTestToolConfig(xumHome, {
      workspaceId: GLOBAL_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
    }),
    xumScope: {
      type: "global" as const,
      xumHome,
    },
  };
}

function createProjectXumAgentsToolConfig(
  xumHome: string,
  workspaceSessionDir: string,
  projectRoot: string
) {
  const xumScope: XumToolScope = {
    type: "project",
    xumHome,
    projectRoot,
    projectStorageAuthority: "host-local",
  };

  return {
    ...createTestToolConfig(xumHome, {
      workspaceId: GLOBAL_WORKSPACE_ID,
      sessionsDir: workspaceSessionDir,
    }),
    cwd: projectRoot,
    xumScope,
  };
}
const REMOTE_WORKSPACE_ROOT = "/remote/workspace";
const TILDE_WORKSPACE_ROOT = "~/mux/project/main";

function isAgentsPathProbeCommand(command: string): boolean {
  return (
    command.includes("__MUX_DANGLING__") &&
    command.includes("__MUX_EXISTS__") &&
    command.includes("__MUX_MISSING__")
  );
}

function createMockExecStream({
  stdout = "",
  stderr = "",
  exitCode,
}: {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}): Awaited<ReturnType<LocalRuntime["exec"]>> {
  const toReadableStream = (content: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (content.length > 0) {
          controller.enqueue(new TextEncoder().encode(content));
        }
        controller.close();
      },
    });

  return {
    stdout: toReadableStream(stdout),
    stderr: toReadableStream(stderr),
    stdin: new WritableStream<Uint8Array>(),
    exitCode: Promise.resolve(exitCode),
    duration: Promise.resolve(0),
  };
}

function mockAgentsPathProbe(
  runtime: RemotePathMappedRuntime,
  result: { stdout?: string; stderr?: string; exitCode: number }
) {
  const originalExec = runtime.exec.bind(runtime);
  return spyOn(runtime, "exec").mockImplementation((command, options) => {
    if (isAgentsPathProbeCommand(command)) {
      return Promise.resolve(createMockExecStream(result));
    }
    return originalExec(command, options);
  });
}

/** Simulates BSD/macOS where readlink doesn't support -f */
class NoReadlinkFRemoteRuntime extends RemotePathMappedRuntime {
  override exec(
    command: string,
    options: Parameters<LocalRuntime["exec"]>[1]
  ): ReturnType<LocalRuntime["exec"]> {
    if (command.includes("readlink -f")) {
      return super.exec("echo 'readlink: illegal option -- f' >&2; exit 1", options);
    }
    return super.exec(command, options);
  }
}

function createRemoteProjectXumAgentsToolConfig(
  xumHome: string,
  workspaceSessionDir: string,
  localProjectRoot: string
) {
  const runtime = new RemotePathMappedRuntime(localProjectRoot, REMOTE_WORKSPACE_ROOT);
  const xumScope: XumToolScope = {
    type: "project",
    xumHome,
    projectRoot: localProjectRoot,
    projectStorageAuthority: "runtime",
  };

  return {
    ...createTestToolConfig(xumHome, {
      workspaceId: "ssh-workspace",
      sessionsDir: workspaceSessionDir,
      runtime,
    }),
    cwd: REMOTE_WORKSPACE_ROOT,
    xumScope,
  };
}

describe("xum_agents_* tools", () => {
  it("reads ~/.mux/AGENTS.md (returns empty string if missing)", async () => {
    using xumHome = new TestTempDir("mux-global-agents");

    const workspaceSessionDir = path.join(xumHome.path, "sessions", GLOBAL_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const config = createGlobalXumAgentsToolConfig(xumHome.path, workspaceSessionDir);

    const tool = createXumAgentsReadTool(config);

    // Missing file -> empty
    const missing = (await tool.execute!({}, mockToolCallOptions)) as {
      success: boolean;
      content?: string;
    };
    expect(missing.success).toBe(true);
    if (missing.success) {
      expect(missing.content).toBe("");
    }

    // Present file -> contents
    const agentsPath = path.join(xumHome.path, "AGENTS.md");
    await fs.writeFile(
      agentsPath,
      `# ${GLOBAL_WORKSPACE_TITLE}\n${GLOBAL_WORKSPACE_NAME}\n`,
      "utf-8"
    );

    const result = (await tool.execute!({}, mockToolCallOptions)) as {
      success: boolean;
      content?: string;
    };
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toContain(GLOBAL_WORKSPACE_TITLE);
      expect(result.content).toContain(GLOBAL_WORKSPACE_NAME);
    }
  });

  it("reads project AGENTS.md when scope is project", async () => {
    using xumHome = new TestTempDir("mux-project-agents-read");

    const workspaceSessionDir = path.join(xumHome.path, "sessions", GLOBAL_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const projectRoot = path.join(xumHome.path, "my-project");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "# Project agents\n", "utf-8");

    const config = createProjectXumAgentsToolConfig(xumHome.path, workspaceSessionDir, projectRoot);
    const tool = createXumAgentsReadTool(config);

    const result = (await tool.execute!({}, mockToolCallOptions)) as {
      success: boolean;
      content?: string;
    };

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.content).toContain("Project agents");
    }
  });
  it("refuses to write without explicit confirmation", async () => {
    using xumHome = new TestTempDir("mux-global-agents");

    const workspaceSessionDir = path.join(xumHome.path, "sessions", GLOBAL_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const config = createGlobalXumAgentsToolConfig(xumHome.path, workspaceSessionDir);

    const tool = createXumAgentsWriteTool(config);

    const agentsPath = path.join(xumHome.path, "AGENTS.md");

    const result = (await tool.execute!(
      { newContent: "test", confirm: false },
      mockToolCallOptions
    )) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("confirm");
    }

    let readError: unknown;
    try {
      await fs.readFile(agentsPath, "utf-8");
    } catch (error) {
      readError = error;
    }

    expect(readError).toMatchObject({ code: "ENOENT" });
  });

  it("writes ~/.mux/AGENTS.md and returns a diff", async () => {
    using xumHome = new TestTempDir("mux-global-agents");

    const workspaceSessionDir = path.join(xumHome.path, "sessions", GLOBAL_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const config = createGlobalXumAgentsToolConfig(xumHome.path, workspaceSessionDir);

    const tool = createXumAgentsWriteTool(config);

    const newContent = "# Global agents\n\nHello\n";

    const result = (await tool.execute!({ newContent, confirm: true }, mockToolCallOptions)) as {
      success: boolean;
      diff?: string;
      ui_only?: { file_edit?: { diff?: string } };
    };

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.diff).toBe(FILE_EDIT_DIFF_OMITTED_MESSAGE);
      expect(result.ui_only?.file_edit?.diff).toContain("AGENTS.md");
    }

    const written = await fs.readFile(path.join(xumHome.path, "AGENTS.md"), "utf-8");
    expect(written).toBe(newContent);
  });

  it("writes project AGENTS.md when scope is project", async () => {
    using xumHome = new TestTempDir("mux-project-agents-write");

    const workspaceSessionDir = path.join(xumHome.path, "sessions", GLOBAL_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const projectRoot = path.join(xumHome.path, "my-project");
    await fs.mkdir(projectRoot, { recursive: true });

    const config = createProjectXumAgentsToolConfig(xumHome.path, workspaceSessionDir, projectRoot);
    const tool = createXumAgentsWriteTool(config);

    const newContent = "# Project agents\n\nProject scoped\n";
    const result = (await tool.execute!({ newContent, confirm: true }, mockToolCallOptions)) as {
      success: boolean;
      diff?: string;
      ui_only?: { file_edit?: { diff?: string } };
    };

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.diff).toBe(FILE_EDIT_DIFF_OMITTED_MESSAGE);
      expect(result.ui_only?.file_edit?.diff).toContain("AGENTS.md");
    }

    const written = await fs.readFile(path.join(projectRoot, "AGENTS.md"), "utf-8");
    expect(written).toBe(newContent);
  });
  it("reads and writes project AGENTS.md through an in-root symlink", async () => {
    using xumHome = new TestTempDir("mux-project-agents-symlink");

    const workspaceSessionDir = path.join(xumHome.path, "sessions", GLOBAL_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const projectRoot = path.join(xumHome.path, "my-project");
    const docsDir = path.join(projectRoot, "docs");
    await fs.mkdir(docsDir, { recursive: true });

    const targetPath = path.join(docsDir, "AGENTS.md");
    await fs.writeFile(targetPath, "# Project agents\n\nOriginal\n", "utf-8");
    await fs.symlink(path.join("docs", "AGENTS.md"), path.join(projectRoot, "AGENTS.md"));

    const config = createProjectXumAgentsToolConfig(xumHome.path, workspaceSessionDir, projectRoot);
    const readTool = createXumAgentsReadTool(config);
    const writeTool = createXumAgentsWriteTool(config);

    const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
      success: boolean;
      content?: string;
    };
    expect(readResult.success).toBe(true);
    if (readResult.success) {
      expect(readResult.content).toContain("Original");
    }

    const newContent = "# Project agents\n\nUpdated through symlink\n";
    const writeResult = (await writeTool.execute!(
      { newContent, confirm: true },
      mockToolCallOptions
    )) as {
      success: boolean;
      diff?: string;
      ui_only?: { file_edit?: { diff?: string } };
    };

    expect(writeResult.success).toBe(true);
    if (writeResult.success) {
      expect(writeResult.diff).toBe(FILE_EDIT_DIFF_OMITTED_MESSAGE);
      expect(writeResult.ui_only?.file_edit?.diff).toContain("AGENTS.md");
    }

    const writtenTarget = await fs.readFile(targetPath, "utf-8");
    expect(writtenTarget).toBe(newContent);
  });

  it("rejects dangling AGENTS.md symlinks for read and write", async () => {
    using xumHome = new TestTempDir("mux-project-agents-dangling-symlink");

    const workspaceSessionDir = path.join(xumHome.path, "sessions", GLOBAL_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const projectRoot = path.join(xumHome.path, "my-project");
    const outsideDir = path.join(xumHome.path, "outside");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    const danglingTarget = path.join(outsideDir, "AGENTS.md");
    await fs.symlink(danglingTarget, path.join(projectRoot, "AGENTS.md"));

    const config = createProjectXumAgentsToolConfig(xumHome.path, workspaceSessionDir, projectRoot);
    const readTool = createXumAgentsReadTool(config);
    const writeTool = createXumAgentsWriteTool(config);

    const writeResult = (await writeTool.execute!(
      { newContent: "# should fail\n", confirm: true },
      mockToolCallOptions
    )) as { success: boolean; error?: string };
    expect(writeResult.success).toBe(false);
    if (!writeResult.success) {
      expect(writeResult.error).toContain("dangling symlink");
    }

    const accessError = await fs.access(danglingTarget).catch((e: unknown) => e);
    expect(accessError).toMatchObject({ code: "ENOENT" });

    const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
      success: boolean;
      error?: string;
    };
    expect(readResult.success).toBe(false);
    if (!readResult.success) {
      expect(readResult.error).toContain("dangling symlink");
    }
  });

  it("rejects AGENTS.md symlink targets that escape the expected root", async () => {
    using xumHome = new TestTempDir("mux-global-agents");
    using outsideRoot = new TestTempDir("mux-global-agents-outside-root");

    const workspaceSessionDir = path.join(xumHome.path, "sessions", GLOBAL_WORKSPACE_ID);
    await fs.mkdir(workspaceSessionDir, { recursive: true });

    const config = createGlobalXumAgentsToolConfig(xumHome.path, workspaceSessionDir);

    const readTool = createXumAgentsReadTool(config);
    const writeTool = createXumAgentsWriteTool(config);

    const agentsPath = path.join(xumHome.path, "AGENTS.md");
    const targetPath = path.join(outsideRoot.path, "target.txt");
    await fs.writeFile(targetPath, "secret", "utf-8");
    await fs.symlink(targetPath, agentsPath);

    const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
      success: boolean;
      error?: string;
    };
    expect(readResult.success).toBe(false);
    if (!readResult.success) {
      expect(readResult.error).toContain("escapes expected root");
    }

    const writeResult = (await writeTool.execute!(
      { newContent: "nope", confirm: true },
      mockToolCallOptions
    )) as { success: boolean; error?: string };
    expect(writeResult.success).toBe(false);
    if (!writeResult.success) {
      expect(writeResult.error).toContain("escapes expected root");
    }
  });

  describe("missing root directory self-healing", () => {
    it("read returns empty content when root directory does not exist", async () => {
      using tempDir = new TestTempDir("mux-global-agents-missing-root-read");

      const workspaceId = "missing-root-read";
      const nonexistentMuxHome = path.join(tempDir.path, "nonexistent-mux-home");
      const workspaceSessionDir = path.join(tempDir.path, "sessions", workspaceId);
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const config = {
        ...createTestToolConfig(nonexistentMuxHome, {
          workspaceId,
          sessionsDir: workspaceSessionDir,
        }),
        cwd: nonexistentMuxHome,
        xumScope: {
          type: "global" as const,
          xumHome: nonexistentMuxHome,
        },
      };

      const readTool = createXumAgentsReadTool(config);
      const result = (await readTool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("");
      }
    });

    it("write succeeds and creates root directory when absent", async () => {
      using tempDir = new TestTempDir("mux-global-agents-missing-root-write");

      const workspaceId = "missing-root-write";
      const nonexistentMuxHome = path.join(tempDir.path, "nonexistent-mux-home");
      const workspaceSessionDir = path.join(tempDir.path, "sessions", workspaceId);
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const config = {
        ...createTestToolConfig(nonexistentMuxHome, {
          workspaceId,
          sessionsDir: workspaceSessionDir,
        }),
        cwd: nonexistentMuxHome,
        xumScope: {
          type: "global" as const,
          xumHome: nonexistentMuxHome,
        },
      };

      const writeTool = createXumAgentsWriteTool(config);
      const newContent = "# Test AGENTS";
      const result = (await writeTool.execute!(
        { newContent, confirm: true },
        mockToolCallOptions
      )) as { success: boolean };

      expect(result.success).toBe(true);

      const written = await fs.readFile(path.join(nonexistentMuxHome, "AGENTS.md"), "utf-8");
      expect(written).toBe(newContent);
    });

    it("read sees content after write to previously-missing root", async () => {
      using tempDir = new TestTempDir("mux-global-agents-missing-root-round-trip");

      const workspaceId = "missing-root-round-trip";
      const nonexistentMuxHome = path.join(tempDir.path, "nonexistent-mux-home");
      const workspaceSessionDir = path.join(tempDir.path, "sessions", workspaceId);
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const config = {
        ...createTestToolConfig(nonexistentMuxHome, {
          workspaceId,
          sessionsDir: workspaceSessionDir,
        }),
        cwd: nonexistentMuxHome,
        xumScope: {
          type: "global" as const,
          xumHome: nonexistentMuxHome,
        },
      };

      const writeTool = createXumAgentsWriteTool(config);
      const readTool = createXumAgentsReadTool(config);
      const newContent = "# Test AGENTS\n\nRound trip\n";

      const writeResult = (await writeTool.execute!(
        { newContent, confirm: true },
        mockToolCallOptions
      )) as { success: boolean };
      expect(writeResult.success).toBe(true);

      const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };
      expect(readResult.success).toBe(true);
      if (readResult.success) {
        expect(readResult.content).toBe(newContent);
      }
    });

    it("write fails when project root directory does not exist", async () => {
      using tempDir = new TestTempDir("mux-project-agents-missing-root-write");

      const workspaceSessionDir = path.join(tempDir.path, "sessions", "project-missing-root-write");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const nonexistentProjectRoot = path.join(tempDir.path, "nonexistent-project");
      const config = createProjectXumAgentsToolConfig(
        tempDir.path,
        workspaceSessionDir,
        nonexistentProjectRoot
      );

      const writeTool = createXumAgentsWriteTool(config);
      const result = (await writeTool.execute!(
        { newContent: "# Test AGENTS", confirm: true },
        mockToolCallOptions
      )) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(existsSync(nonexistentProjectRoot)).toBe(false);
    });

    it("read returns empty content when project root directory does not exist", async () => {
      using tempDir = new TestTempDir("mux-project-agents-missing-root-read");

      const workspaceSessionDir = path.join(tempDir.path, "sessions", "project-missing-root-read");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const nonexistentProjectRoot = path.join(tempDir.path, "nonexistent-project");
      const config = createProjectXumAgentsToolConfig(
        tempDir.path,
        workspaceSessionDir,
        nonexistentProjectRoot
      );

      const readTool = createXumAgentsReadTool(config);
      const result = (await readTool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("");
      }
      expect(existsSync(nonexistentProjectRoot)).toBe(false);
    });
  });

  describe("split-root (SSH/Docker) project workspaces", () => {
    it("reads AGENTS.md from runtime workspace (not host project root)", async () => {
      using xumHome = new TestTempDir("mux-project-agents-split-root-read");

      const workspaceSessionDir = path.join(xumHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(xumHome.path, "host-project");
      const runtimeWorkspaceRoot = path.join(xumHome.path, "runtime-project");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });

      await fs.writeFile(path.join(hostProjectRoot, "AGENTS.md"), "# Host AGENTS\n", "utf-8");
      await fs.writeFile(
        path.join(runtimeWorkspaceRoot, "AGENTS.md"),
        "# Runtime AGENTS\n",
        "utf-8"
      );

      const config = createRemoteProjectXumAgentsToolConfig(
        xumHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      config.runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);

      const tool = createXumAgentsReadTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("# Runtime AGENTS\n");
      }
    });

    it("reads AGENTS.md from tilde-prefixed runtime workspace", async () => {
      using xumHome = new TestTempDir("mux-project-agents-split-root-read-tilde");

      const workspaceSessionDir = path.join(xumHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(xumHome.path, "host-project");
      const runtimeHomeRoot = path.join(xumHome.path, "remote-home");
      const runtimeWorkspaceRoot = path.join(runtimeHomeRoot, "mux", "project", "main");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });

      await fs.writeFile(
        path.join(runtimeWorkspaceRoot, "AGENTS.md"),
        "# Tilde Runtime AGENTS\n",
        "utf-8"
      );

      const config = createRemoteProjectXumAgentsToolConfig(
        xumHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      config.runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, TILDE_WORKSPACE_ROOT);
      config.cwd = TILDE_WORKSPACE_ROOT;

      const tool = createXumAgentsReadTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("# Tilde Runtime AGENTS\n");
      }
    });

    it("reads AGENTS.md through symlink in tilde-prefixed runtime workspace", async () => {
      using xumHome = new TestTempDir("mux-project-agents-split-root-read-tilde-symlink");

      const workspaceSessionDir = path.join(xumHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(xumHome.path, "host-project");
      const runtimeHomeRoot = path.join(xumHome.path, "remote-home");
      const runtimeWorkspaceRoot = path.join(runtimeHomeRoot, "mux", "project", "main");
      const docsDir = path.join(runtimeWorkspaceRoot, "docs");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(docsDir, { recursive: true });

      await fs.writeFile(
        path.join(docsDir, "AGENTS.md"),
        "# Tilde Runtime Symlink AGENTS\n",
        "utf-8"
      );
      await fs.symlink(
        path.join("docs", "AGENTS.md"),
        path.join(runtimeWorkspaceRoot, "AGENTS.md")
      );

      const config = createRemoteProjectXumAgentsToolConfig(
        xumHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      config.runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, TILDE_WORKSPACE_ROOT);
      config.cwd = TILDE_WORKSPACE_ROOT;

      const tool = createXumAgentsReadTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.content).toBe("# Tilde Runtime Symlink AGENTS\n");
      }
    });

    it("rejects AGENTS.md symlink escape in tilde-prefixed runtime workspace", async () => {
      using xumHome = new TestTempDir("mux-project-agents-split-root-tilde-symlink-escape");

      const workspaceSessionDir = path.join(xumHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(xumHome.path, "host-project");
      const runtimeHomeRoot = path.join(xumHome.path, "remote-home");
      const runtimeWorkspaceRoot = path.join(runtimeHomeRoot, "mux", "project", "main");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });

      const escapeTarget = path.join(xumHome.path, "secret.md");
      await fs.writeFile(escapeTarget, "secret content", "utf-8");
      await fs.symlink(escapeTarget, path.join(runtimeWorkspaceRoot, "AGENTS.md"));

      const config = createRemoteProjectXumAgentsToolConfig(
        xumHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      config.runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, TILDE_WORKSPACE_ROOT);
      config.cwd = TILDE_WORKSPACE_ROOT;

      const tool = createXumAgentsReadTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain("escapes");
    });

    it("reads empty string when AGENTS.md missing in runtime workspace", async () => {
      using xumHome = new TestTempDir("mux-project-agents-split-root-read-missing");

      const workspaceSessionDir = path.join(xumHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(xumHome.path, "host-project");
      const runtimeWorkspaceRoot = path.join(xumHome.path, "runtime-project");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });

      const config = createRemoteProjectXumAgentsToolConfig(
        xumHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      config.runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);

      const tool = createXumAgentsReadTool(config);
      const result = (await tool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };

      expect(result).toEqual({ success: true, content: "" });
    });

    it("returns an error when the runtime AGENTS probe exits non-zero during read", async () => {
      using xumHome = new TestTempDir("mux-project-agents-split-root-read-probe-error");

      const workspaceSessionDir = path.join(xumHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(xumHome.path, "host-project");
      const runtimeWorkspaceRoot = path.join(xumHome.path, "runtime-project");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });
      await fs.writeFile(
        path.join(runtimeWorkspaceRoot, "AGENTS.md"),
        "# Runtime AGENTS\n",
        "utf-8"
      );

      const config = createRemoteProjectXumAgentsToolConfig(
        xumHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      const runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);
      config.runtime = runtime;

      const execSpy = mockAgentsPathProbe(runtime, {
        stderr: "ssh probe failed",
        exitCode: 255,
      });

      try {
        const tool = createXumAgentsReadTool(config);
        const result = (await tool.execute!({}, mockToolCallOptions)) as {
          success: boolean;
          error?: string;
        };

        expect(result.success).toBe(false);
        expect(result.error).toContain("Runtime AGENTS.md probe failed");
        expect(result.error).toContain("ssh probe failed");
      } finally {
        execSpy.mockRestore();
      }
    });

    it("returns an error when the runtime AGENTS probe exits non-zero during write", async () => {
      using xumHome = new TestTempDir("mux-project-agents-split-root-write-probe-error");

      const workspaceSessionDir = path.join(xumHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(xumHome.path, "host-project");
      const runtimeWorkspaceRoot = path.join(xumHome.path, "runtime-project");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });
      await fs.writeFile(
        path.join(runtimeWorkspaceRoot, "AGENTS.md"),
        "# Runtime AGENTS\n",
        "utf-8"
      );

      const config = createRemoteProjectXumAgentsToolConfig(
        xumHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      const runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);
      config.runtime = runtime;

      const execSpy = mockAgentsPathProbe(runtime, {
        stderr: "ssh probe failed",
        exitCode: 255,
      });

      try {
        const tool = createXumAgentsWriteTool(config);
        const result = (await tool.execute!(
          { newContent: "# Updated Runtime AGENTS", confirm: true },
          mockToolCallOptions
        )) as { success: boolean; error?: string };

        expect(result.success).toBe(false);
        expect(result.error).toContain("Runtime AGENTS.md probe failed");
        expect(result.error).toContain("ssh probe failed");

        const runtimeAgentsPath = path.join(runtimeWorkspaceRoot, "AGENTS.md");
        const runtimeContent = await fs.readFile(runtimeAgentsPath, "utf-8");
        expect(runtimeContent).toBe("# Runtime AGENTS\n");
      } finally {
        execSpy.mockRestore();
      }
    });

    it("returns an error when the runtime AGENTS probe prints unexpected stdout", async () => {
      using xumHome = new TestTempDir("mux-project-agents-split-root-unexpected-probe-stdout");

      const runtimeWorkspaceRoot = path.join(xumHome.path, "runtime-project");
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });

      const runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);
      const execSpy = mockAgentsPathProbe(runtime, {
        stdout: "unexpected\n",
        exitCode: 0,
      });

      try {
        const resolved = await resolveAgentsPathOnRuntime(runtime, REMOTE_WORKSPACE_ROOT);

        expect(resolved.kind).toBe("error");
        if (resolved.kind === "error") {
          expect(resolved.error).toContain("unexpected output");
        }
      } finally {
        execSpy.mockRestore();
      }
    });

    it("writes AGENTS.md to runtime workspace (leaves host project root unchanged)", async () => {
      using xumHome = new TestTempDir("mux-project-agents-split-root-write");

      const workspaceSessionDir = path.join(xumHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(xumHome.path, "host-project");
      const runtimeWorkspaceRoot = path.join(xumHome.path, "runtime-project");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(runtimeWorkspaceRoot, { recursive: true });

      const hostAgentsPath = path.join(hostProjectRoot, "AGENTS.md");
      await fs.writeFile(hostAgentsPath, "# Host AGENTS\n", "utf-8");

      const config = createRemoteProjectXumAgentsToolConfig(
        xumHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      config.runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);

      const tool = createXumAgentsWriteTool(config);
      const result = (await tool.execute!(
        { newContent: "# Remote AGENTS", confirm: true },
        mockToolCallOptions
      )) as {
        success: boolean;
        diff?: string;
        ui_only?: { file_edit?: { diff?: string } };
      };

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.diff).toBe(FILE_EDIT_DIFF_OMITTED_MESSAGE);
        expect(result.ui_only?.file_edit?.diff).toContain("AGENTS.md");
      }

      const runtimeAgentsPath = path.join(runtimeWorkspaceRoot, "AGENTS.md");
      const runtimeContent = await fs.readFile(runtimeAgentsPath, "utf-8");
      expect(runtimeContent).toBe("# Remote AGENTS");

      const hostContent = await fs.readFile(hostAgentsPath, "utf-8");
      expect(hostContent).toBe("# Host AGENTS\n");
    });
    it("writes through runtime AGENTS.md symlinks without replacing them", async () => {
      using xumHome = new TestTempDir("mux-project-agents-split-root-write-symlink");

      const workspaceSessionDir = path.join(xumHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const hostProjectRoot = path.join(xumHome.path, "host-project");
      const runtimeWorkspaceRoot = path.join(xumHome.path, "runtime-project");
      const docsDir = path.join(runtimeWorkspaceRoot, "docs");
      await fs.mkdir(hostProjectRoot, { recursive: true });
      await fs.mkdir(docsDir, { recursive: true });

      const agentsPath = path.join(runtimeWorkspaceRoot, "AGENTS.md");
      const targetPath = path.join(docsDir, "AGENTS.md");
      const symlinkTarget = path.join("docs", "AGENTS.md");
      await fs.writeFile(targetPath, "# Runtime Symlink AGENTS\n", "utf-8");
      await fs.symlink(symlinkTarget, agentsPath);

      const config = createRemoteProjectXumAgentsToolConfig(
        xumHome.path,
        workspaceSessionDir,
        hostProjectRoot
      );
      const runtime = new RemotePathMappedRuntime(runtimeWorkspaceRoot, REMOTE_WORKSPACE_ROOT);
      config.runtime = runtime;

      const resolved = await resolveAgentsPathOnRuntime(runtime, REMOTE_WORKSPACE_ROOT);
      expect(resolved.kind).toBe("existing");
      if (resolved.kind === "existing") {
        expect(resolved.realPath).toBe(runtime.normalizePath(symlinkTarget, REMOTE_WORKSPACE_ROOT));
      }

      const tool = createXumAgentsWriteTool(config);
      const newContent = "# Updated Runtime Symlink AGENTS\n";
      const result = (await tool.execute!({ newContent, confirm: true }, mockToolCallOptions)) as {
        success: boolean;
      };
      expect(result.success).toBe(true);

      const writtenTarget = await fs.readFile(targetPath, "utf-8");
      expect(writtenTarget).toBe(newContent);

      const linkStat = await fs.lstat(agentsPath);
      expect(linkStat.isSymbolicLink()).toBe(true);
      expect(await fs.readlink(agentsPath)).toBe(symlinkTarget);
    });

    it("rejects AGENTS.md symlink targets that escape runtime workspace root", async () => {
      using xumHome = new TestTempDir("mux-remote-agents-symlink-escape");

      const workspaceSessionDir = path.join(xumHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      // Create a project root with workspace backing dir
      const projectRoot = path.join(xumHome.path, "my-project");
      await fs.mkdir(projectRoot, { recursive: true });

      // Create an escape target outside the workspace root
      const escapeTarget = path.join(xumHome.path, "secret.md");
      await fs.writeFile(escapeTarget, "secret content", "utf-8");

      // Create AGENTS.md as symlink pointing outside workspace root
      await fs.symlink(escapeTarget, path.join(projectRoot, "AGENTS.md"));

      const config = createRemoteProjectXumAgentsToolConfig(
        xumHome.path,
        workspaceSessionDir,
        projectRoot
      );

      const readTool = createXumAgentsReadTool(config);
      const writeTool = createXumAgentsWriteTool(config);

      // Read should reject the symlink escape
      const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        error?: string;
      };
      expect(readResult.success).toBe(false);
      expect(readResult.error).toContain("escapes");

      // Write should also reject
      const writeResult = (await writeTool.execute!(
        { newContent: "hacked", confirm: true },
        mockToolCallOptions
      )) as { success: boolean; error?: string };
      expect(writeResult.success).toBe(false);
      expect(writeResult.error).toContain("escapes");

      // Verify escape target was not modified
      const secretContent = await fs.readFile(escapeTarget, "utf-8");
      expect(secretContent).toBe("secret content");
    });

    it("rejects dangling symlinks in runtime workspace", async () => {
      using xumHome = new TestTempDir("mux-remote-agents-dangling-symlink");

      const workspaceSessionDir = path.join(xumHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const projectRoot = path.join(xumHome.path, "my-project");
      await fs.mkdir(projectRoot, { recursive: true });

      const config = createRemoteProjectXumAgentsToolConfig(
        xumHome.path,
        workspaceSessionDir,
        projectRoot
      );

      const readTool = createXumAgentsReadTool(config);
      const writeTool = createXumAgentsWriteTool(config);

      const externalTarget = path.join(projectRoot, "..", "outside", "missing.md");
      const agentsPath = path.join(projectRoot, "AGENTS.md");
      await fs.symlink(externalTarget, agentsPath);

      const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        error?: string;
      };
      expect(readResult.success).toBe(false);
      expect(readResult.error).toContain("dangling symlink");

      const writeResult = (await writeTool.execute!(
        { newContent: "# Hacked", confirm: true },
        mockToolCallOptions
      )) as { success: boolean; error?: string };
      expect(writeResult.success).toBe(false);
      expect(writeResult.error).toContain("dangling symlink");

      const targetExists = await fs
        .access(externalTarget)
        .then(() => true)
        .catch(() => false);
      expect(targetExists).toBe(false);
    });

    it("works on BSD-like runtimes without GNU readlink -f", async () => {
      using xumHome = new TestTempDir("mux-remote-agents-bsd-compat");

      const workspaceSessionDir = path.join(xumHome.path, "sessions", "ssh-workspace");
      await fs.mkdir(workspaceSessionDir, { recursive: true });

      const projectRoot = path.join(xumHome.path, "my-project");
      await fs.mkdir(projectRoot, { recursive: true });
      await fs.writeFile(path.join(projectRoot, "AGENTS.md"), "# BSD Test\n", "utf-8");

      const config = createRemoteProjectXumAgentsToolConfig(
        xumHome.path,
        workspaceSessionDir,
        projectRoot
      );
      // Replace runtime with one that rejects readlink -f
      config.runtime = new NoReadlinkFRemoteRuntime(projectRoot, REMOTE_WORKSPACE_ROOT);

      const readTool = createXumAgentsReadTool(config);
      const readResult = (await readTool.execute!({}, mockToolCallOptions)) as {
        success: boolean;
        content?: string;
      };
      expect(readResult.success).toBe(true);
      expect(readResult.content).toContain("BSD Test");

      const writeTool = createXumAgentsWriteTool(config);
      const writeResult = (await writeTool.execute!(
        { newContent: "# Updated BSD", confirm: true },
        mockToolCallOptions
      )) as { success: boolean };
      expect(writeResult.success).toBe(true);
    });
  });
});
